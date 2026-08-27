import { ValueTransformer } from 'typeorm';

// pg returns 'numeric'/'decimal' columns as strings to avoid losing precision,
// which leaks into the API as `total: "301.50"` instead of a number. For
// numeric(10,2) the whole range fits exactly in a double, so converting a
// single value on read is safe. Accumulating those values in floating point is
// still approximate, but that is pre-existing and out of scope for this fix.
// On write the value is passed through unchanged: `to` is also applied to query
// parameters in some paths, so identity is the only implementation that cannot
// alter a value where it is not expected.
export const decimalColumnTransformer: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
