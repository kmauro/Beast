import { z } from 'zod';

const RotationInputSchema = z.object({
  activeSellerIds: z.array(z.string().min(1)).min(1),
  currentSellerId: z.string().min(1).nullable(),
  assignmentsInBatch: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
});

export interface RotationResult {
  sellerId: string;
  assignmentsInBatch: number;
}

export function nextSeller(input: z.input<typeof RotationInputSchema>): RotationResult {
  const value = RotationInputSchema.parse(input);
  const currentIndex = value.currentSellerId
    ? value.activeSellerIds.indexOf(value.currentSellerId)
    : -1;

  if (currentIndex === -1) {
    return { sellerId: value.activeSellerIds[0]!, assignmentsInBatch: 1 };
  }

  if (value.assignmentsInBatch < value.batchSize) {
    return {
      sellerId: value.activeSellerIds[currentIndex]!,
      assignmentsInBatch: value.assignmentsInBatch + 1,
    };
  }

  const nextIndex = (currentIndex + 1) % value.activeSellerIds.length;
  return { sellerId: value.activeSellerIds[nextIndex]!, assignmentsInBatch: 1 };
}

