import type { RequestHandler } from 'express';
import { requireUserId } from '../middlewares/require-auth.js';
import { validatedQuery } from '../middlewares/validate.js';
import { toAlertResponse } from '../mappers/alert.mapper.js';
import type {
  AlertIdParam,
  CreateAlertInput,
  ListAlertsQuery,
  UpdateAlertInput,
} from '../schemas/alert.schema.js';
import * as alertService from '../services/alert.service.js';

/**
 * The generic arguments are the schemas' inferred types, which is what makes
 * `req.params.id` a `string` rather than Express 5's `string | string[]` and
 * lets the bodies be read without a cast — `never` where a route has no params
 * at all. They are only sound because every route runs the matching
 * `validate(...)`.
 */

export const create: RequestHandler<never, unknown, CreateAlertInput> = async (req, res) => {
  const alert = await alertService.createAlert(requireUserId(req), req.body);

  res.status(201).location(`/alerts/${alert.id}`).json(toAlertResponse(alert));
};

export const list: RequestHandler = async (req, res) => {
  // Not `req.query`: Express 5 defines it as a getter with no setter, so
  // `validate` leaves the parsed value on `res.locals` instead.
  const query = validatedQuery<ListAlertsQuery>(res);
  const { data, nextCursor } = await alertService.listAlerts(requireUserId(req), query);

  res.status(200).json({ data: data.map(toAlertResponse), nextCursor });
};

export const getById: RequestHandler<AlertIdParam> = async (req, res) => {
  const alert = await alertService.getAlertById(requireUserId(req), req.params.id);

  res.status(200).json(toAlertResponse(alert));
};

export const update: RequestHandler<AlertIdParam, unknown, UpdateAlertInput> = async (req, res) => {
  const alert = await alertService.updateAlert(requireUserId(req), req.params.id, req.body);

  res.status(200).json(toAlertResponse(alert));
};

export const remove: RequestHandler<AlertIdParam> = async (req, res) => {
  await alertService.deleteAlert(requireUserId(req), req.params.id);

  res.status(204).end();
};
