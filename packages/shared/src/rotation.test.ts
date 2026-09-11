import { describe, expect, it } from 'vitest';
import { nextSeller } from './rotation.js';

describe('nextSeller', () => {
  const activeSellerIds = ['seller-1', 'seller-2'];

  it('inicia la rotación con el primer vendedor', () => {
    expect(
      nextSeller({ activeSellerIds, currentSellerId: null, assignmentsInBatch: 0, batchSize: 5 }),
    ).toEqual({ sellerId: 'seller-1', assignmentsInBatch: 1 });
  });

  it('mantiene el vendedor durante cinco asignaciones', () => {
    expect(
      nextSeller({
        activeSellerIds,
        currentSellerId: 'seller-1',
        assignmentsInBatch: 4,
        batchSize: 5,
      }),
    ).toEqual({ sellerId: 'seller-1', assignmentsInBatch: 5 });
  });

  it('rota al siguiente vendedor después de completar el bloque', () => {
    expect(
      nextSeller({
        activeSellerIds,
        currentSellerId: 'seller-1',
        assignmentsInBatch: 5,
        batchSize: 5,
      }),
    ).toEqual({ sellerId: 'seller-2', assignmentsInBatch: 1 });
  });

  it('vuelve al primer vendedor después del segundo bloque', () => {
    expect(
      nextSeller({
        activeSellerIds,
        currentSellerId: 'seller-2',
        assignmentsInBatch: 5,
        batchSize: 5,
      }),
    ).toEqual({ sellerId: 'seller-1', assignmentsInBatch: 1 });
  });
});

