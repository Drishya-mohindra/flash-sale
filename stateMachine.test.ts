import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedTransitions,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  ORDER_STATES,
  stockMoveFor,
} from '../src/domain/stateMachine';

test('happy path moves stock reserved -> sold', () => {
  assert.equal(stockMoveFor('RESERVED', 'PAYMENT_PENDING'), null);
  assert.equal(stockMoveFor('PAYMENT_PENDING', 'CONFIRMED'), 'commit');
});

test('every way out of a holding state without a sale releases the unit', () => {
  for (const [from, to, move] of allowedTransitions()) {
    if ((from === 'RESERVED' || from === 'PAYMENT_PENDING') && to !== 'PAYMENT_PENDING' && to !== 'CONFIRMED') {
      assert.equal(move, 'release', `${from} -> ${to}`);
    }
  }
});

test('a confirmed order can never be undone', () => {
  assert.ok(isTerminal('CONFIRMED'));
  for (const to of ORDER_STATES) assert.equal(canTransition('CONFIRMED', to), false);
});

test('cannot skip payment, or cancel once payment started', () => {
  assert.throws(() => stockMoveFor('RESERVED', 'CONFIRMED'), IllegalTransitionError);
  assert.throws(() => stockMoveFor('PAYMENT_PENDING', 'CANCELLED'), IllegalTransitionError);
});

test('late payment on an expired order either takes fresh stock or is refunded', () => {
  assert.equal(stockMoveFor('EXPIRED', 'CONFIRMED'), 'sell_direct');
  assert.equal(stockMoveFor('EXPIRED', 'REFUND_PENDING'), null);
  assert.equal(stockMoveFor('REFUND_PENDING', 'REFUNDED'), null);
});
