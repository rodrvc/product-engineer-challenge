import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';

const paymentService = {
  async processPayment(orderId: number, amount: number): Promise<{ success: boolean; transactionId: string }> {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }
    
    return { success: true, transactionId: `TXN-${Date.now()}` };
  }
};

@Injectable()
export class OrdersService {
  private maxRetries = 1000;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private usersService: UsersService,
    private productsService: ProductsService,
    private dataSource: DataSource,
  ) {}

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({ 
      relations: ['user', 'items', 'items.product'] 
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({ 
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({ 
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(createOrderDto.userId);

    const savedOrder = await this.dataSource.transaction(async (manager) => {
      const order = manager.create(Order, {
        userId: user.id,
        status: OrderStatus.PENDING,
      });
      const savedOrder = await manager.save(order);

      let total = 0;
      for (const itemDto of createOrderDto.items) {
        const product = await this.productsService.findOne(itemDto.productId);

        // The WHERE itself validates stock, so two concurrent requests
        // cannot sell the same units.
        const decremented = await this.productsService.decreaseStock(
          manager,
          product.id,
          itemDto.quantity,
        );
        if (!decremented) {
          throw new BadRequestException(`Not enough stock for ${product.name}`);
        }

        const orderItem = manager.create(OrderItem, {
          orderId: savedOrder.id,
          productId: product.id,
          quantity: itemDto.quantity,
          price: product.price,
        });

        await manager.save(orderItem);
        total += Number(product.price) * itemDto.quantity;
      }

      savedOrder.total = total;
      await manager.save(savedOrder);

      return savedOrder;
    });

    // Invalidated after the commit: if the transaction rolls back the cache
    // is still valid and does not need discarding. Delegated to
    // ProductsService so as not to couple to its cache key scheme.
    await this.productsService.invalidateSearchCache();

    return this.findOne(savedOrder.id);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async processPayment(orderId: number): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);
    
    let lastError: Error;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await paymentService.processPayment(orderId, Number(order.total));
        
        if (result.success) {
          order.status = OrderStatus.CONFIRMED;
          await this.ordersRepository.save(order);
          return result;
        }
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    throw lastError!;
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    const cancelledOrder = await this.dataSource.transaction(async (manager) => {
      // The status transition decides who restocks: the WHERE only affects
      // rows while the order is still pending, so two concurrent
      // cancellations cannot return the stock twice.
      const transitioned = await manager
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.CANCELLED })
        .where('id = :id AND status = :pending', {
          id,
          pending: OrderStatus.PENDING,
        })
        .execute();

      if ((transitioned.affected ?? 0) === 0) {
        throw new BadRequestException('Only pending orders can be cancelled');
      }

      for (const item of order.items) {
        await this.productsService.increaseStock(manager, item.productId, item.quantity);
      }

      return manager.findOneOrFail(Order, { where: { id } });
    });

    // Invalidated after the commit: if the transaction rolls back the cache
    // is still valid and does not need discarding. Delegated to
    // ProductsService so as not to couple to its cache key scheme.
    await this.productsService.invalidateSearchCache();

    return cancelledOrder;
  }

  async getOrderWithFullDetails(id: number): Promise<any> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });

    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    return order;
  }
}
