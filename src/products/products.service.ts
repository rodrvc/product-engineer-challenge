import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, ILike, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  // Redis key holding the current version number of the search cache.
  private readonly searchCacheVersionKey = 'product-search:version';

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({ 
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  async updateStock(id: number, quantity: number): Promise<Product> {
    const product = await this.findOne(id);
    product.stock = quantity;
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  // Atomic decrement: the stock check travels inside the UPDATE itself, so
  // two concurrent decrements cannot oversell.
  // Takes the EntityManager to run inside the caller's transaction.
  async decreaseStock(manager: EntityManager, id: number, quantity: number): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :id AND stock >= :quantity', { id, quantity })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  // Atomic restock, counterpart of the decrement, used on cancellation.
  async increaseStock(manager: EntityManager, id: number, quantity: number): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock + :quantity' })
      .where('id = :id', { id })
      .setParameter('quantity', quantity)
      .execute();
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
    await this.invalidateSearchCache();
  }

  // Invalidates every product search cache entry.
  // Instead of deleting each 'product-search:<query>' key (which would mean
  // knowing or enumerating every term ever searched), a version key that is
  // part of the search keys is incremented: bumping the version orphans the
  // old entries, which expire on their own by TTL, with no pattern-delete
  // commands against Redis.
  // Exposed as a public method so other services (e.g. OrdersService, which
  // invalidates when stock changes through orders) do not need to know
  // ProductsService's cache key scheme.
  async invalidateSearchCache(): Promise<void> {
    const currentVersion =
      (await this.cacheManager.get<number>(this.searchCacheVersionKey)) ?? 0;

    // No expiry: if the version expired it would fall back to zero and
    // searches would read again the old entries this invalidation discarded.
    await this.cacheManager.set(
      this.searchCacheVersionKey,
      currentVersion + 1,
      0,
    );
  }

  async searchProducts(query: string): Promise<Product[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const version = (await this.cacheManager.get<number>(this.searchCacheVersionKey)) ?? 0;
    const cacheKey = `product-search:v${version}:${normalizedQuery}`;

    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Filtering in the database (ILike = case-insensitive) instead of loading
    // the whole table and filtering in memory. The array of conditions in
    // `where` translates to OR, so a product with no description still shows
    // up when its name matches.
    const results = normalizedQuery
      ? await this.productsRepository.find({
          where: [
            { name: ILike(`%${normalizedQuery}%`) },
            { description: ILike(`%${normalizedQuery}%`) },
          ],
        })
      : await this.productsRepository.find();

    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    // Make sure the requested category exists (raises 404 otherwise).
    await this.findCategory(categoryId);

    // findCategory only loads 'parent' and 'children' one level deep, so
    // recursing over those relations breaks past the second level (the
    // property is no longer loaded). Instead of requesting nested relations
    // level by level, the whole categories table is fetched in a single query
    // and the tree is built in memory, both upwards (ancestors) and downwards
    // (descendants). Fine while the catalog stays small; with tens of
    // thousands of rows a recursive CTE is the right call.
    const allCategories = await this.categoriesRepository.find();
    const byId = new Map(allCategories.map(c => [c.id, c]));

    const buildDescendants = (id: number, visited: Set<number>): any => {
      const current = byId.get(id)!;
      const node: any = {
        id: current.id,
        name: current.name,
        children: [],
      };

      if (visited.has(id)) {
        // Cycle detected: stop here returning the node without children
        // instead of throwing, so the endpoint stays useful.
        return node;
      }
      visited.add(id);

      const children = allCategories.filter(c => c.parentId === id);
      node.children = children.map(child => buildDescendants(child.id, visited));

      return node;
    };

    const tree = buildDescendants(categoryId, new Set<number>());

    // Ancestor chain: walk up through parentId to the root, stopping if an id
    // repeats so it does not loop forever in a cycle. Each ancestor keeps
    // children empty on purpose: they are lineage context, and populating them
    // would repeat the branch being walked up.
    const visitedAncestors = new Set<number>([categoryId]);
    let node = tree;
    let current = byId.get(categoryId);

    while (current?.parentId != null && !visitedAncestors.has(current.parentId)) {
      const parent = byId.get(current.parentId);
      if (!parent) {
        break;
      }

      node.parent = { id: parent.id, name: parent.name, children: [] };
      visitedAncestors.add(parent.id);
      node = node.parent;
      current = parent;
    }

    return tree;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;
    
    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
