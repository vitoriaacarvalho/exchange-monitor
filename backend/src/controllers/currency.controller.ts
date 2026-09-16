import type { RequestHandler } from 'express';
import type { CurrencyPairParam } from '../schemas/currency.schema.js';
import * as exchangeRateService from '../services/exchange-rate.service.js';

/**
 * The generic argument is the schema's inferred type, which is what makes
 * `req.params` the split pair rather than Express 5's `string | string[]`. It is
 * only sound because the route runs the matching `validate({ params })`.
 *
 * No `try/catch`: Express 5 forwards a rejected promise to `errorHandler`.
 */
export const getPair: RequestHandler<CurrencyPairParam> = async (req, res) => {
  const { baseCurrency, quoteCurrency } = req.params;
  const rate = await exchangeRateService.getRate(baseCurrency, quoteCurrency);

  res.status(200).json(rate);
};
