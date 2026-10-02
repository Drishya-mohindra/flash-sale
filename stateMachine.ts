// The order lifecycle, and what each transition does to stock.
//
//   (new) --reserve--> RESERVED --pay--> PAYMENT_PENDING --success--> CONFIRMED
//                         |                    |
//                         |-- ttl -----------> EXPIRED <-- deadline --|
//                         |-- user ---------> CANCELLED              |-- failure --> PAYMENT_FAILED
//
//   EXPIRED --late payment success--> CONFIRMED       (if stock can be re-acquired)
//   EXPIRED --late payment success--> REFUND_PENDING --> REFUNDED   (if it cannot)

export const ORDER_STATES = [
  'RESERVED',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

// How a unit of stock moves between inventory buckets.
//   reserve:     available -> reserved   (creating a reservation)
//   release:     reserved  -> available  (reservation ends without a sale)
//   commit:      reserved  -> sold       (payment confirmed for a held unit)
//   sell_direct: available -> sold       (late payment for an order whose hold had lapsed)
export type StockMove = 'reserve' | 'release' | 'commit' | 'sell_direct';

const TRANSITIONS: Record<OrderState, Partial<Record<OrderState, StockMove | null>>> = {
  RESERVED: { PAYMENT_PENDING: null, EXPIRED: 'release', CANCELLED: 'release' },
  PAYMENT_PENDING: { CONFIRMED: 'commit', PAYMENT_FAILED: 'release', EXPIRED: 'release' },
  EXPIRED: { CONFIRMED: 'sell_direct', REFUND_PENDING: null },
  REFUND_PENDING: { REFUNDED: null },
  CONFIRMED: {},
  CANCELLED: {},
  PAYMENT_FAILED: {},
  REFUNDED: {},
};

// States in which the order holds a unit in the `reserved` bucket.
export const HOLDING_STATES: OrderState[] = ['RESERVED', 'PAYMENT_PENDING'];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Illegal order transition ${from} -> ${to}`);
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return to in TRANSITIONS[from];
}

/** The stock movement a transition requires. Throws if the transition is not allowed. */
export function stockMoveFor(from: OrderState, to: OrderState): StockMove | null {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return TRANSITIONS[from][to] ?? null;
}

export function isTerminal(state: OrderState): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}

export function allowedTransitions(): Array<[OrderState, OrderState, StockMove | null]> {
  return ORDER_STATES.flatMap((from) =>
    Object.entries(TRANSITIONS[from]).map(
      ([to, move]) => [from, to as OrderState, move ?? null] as [OrderState, OrderState, StockMove | null],
    ),
  );
}
