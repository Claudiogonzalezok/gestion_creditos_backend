const { computeAvailableCash, computeExpectedTransfer } = require('./cashSessions.calculations');

const totals = {
  collections_payments_cash: 1000,
  collections_down_payments_cash: 200,
  collections_manual_incomes_cash: 50,
  outflows_expenses_cash: 100,
  outflows_commissions_cash: 30,
  outflows_loans_cash: 400,
  conversions_cash_delta: -20,
  drops_cash: 300,
  collections_payments_transfer: 500,
  collections_down_payments_transfer: 100,
  collections_manual_incomes_transfer: 25,
  outflows_expenses_transfer: 40,
  outflows_commissions_transfer: 10,
  outflows_loans_transfer: 200,
  conversions_transfer_delta: 20,
  drops_transfer: 150,
};

describe('cashSessions.calculations', () => {
  it('computeAvailableCash suma apertura + ingresos y resta egresos y drops', () => {
    // 500 + 1000 + 200 + 50 - 100 - 30 - 400 - 20 - 300
    expect(computeAvailableCash({ opening_amount: 500 }, totals)).toBe(900);
  });

  it('computeExpectedTransfer usa las columnas *_transfer con apertura 0', () => {
    // 500 + 100 + 25 - 40 - 10 - 200 + 20 - 150
    expect(computeExpectedTransfer(totals)).toBe(245);
  });
});
