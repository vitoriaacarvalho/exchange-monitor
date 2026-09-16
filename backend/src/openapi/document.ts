import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import type { z } from 'zod';
import {
  alertIdParamSchema,
  createAlertSchema,
  listAlertsQuerySchema,
  updateAlertSchema,
} from '../schemas/alert.schema.js';
import { loginSchema, registerSchema } from '../schemas/auth.schema.js';
import { currencyPairParamSchema } from '../schemas/currency.schema.js';
import { ref, toComponentSchemas, toOpenApiSchema } from './json-schema.js';
import './response.schema.js';

/**
 * Assembled here rather than hand-written as YAML or scanned out of JSDoc
 * comments: both are a second copy of the request rules, and they drift from the
 * Zod schemas the moment someone edits one and not the other.
 *
 * Two `.refine()` rules cannot be expressed in JSON Schema and so are written
 * into the operation descriptions by hand. They are marked below.
 */

/**
 * `openapi-types` models a 3.1 path item by intersecting its own 3.1 operation
 * type with the 3.0 one it was derived from, so anything nested inside `paths`
 * has to satisfy both. Intersecting here is what keeps the document literal
 * below type-checked rather than cast wholesale to `any`.
 */
type SchemaObject = OpenAPIV3.SchemaObject & OpenAPIV3_1.SchemaObject;
type ResponseObject = OpenAPIV3.ResponseObject & OpenAPIV3_1.ResponseObject;
type RequestBodyObject = OpenAPIV3.RequestBodyObject & OpenAPIV3_1.RequestBodyObject;
type ParameterObject = OpenAPIV3.ParameterObject & OpenAPIV3_1.ParameterObject;

// `operationId` on every operation is what a client generator names its methods
// from; without one it invents names out of the path.
const schemaOf = (schema: z.ZodType) => toOpenApiSchema(schema) as SchemaObject;

const jsonBody = (schema: z.ZodType): RequestBodyObject => ({
  required: true,
  content: { 'application/json': { schema: schemaOf(schema) } },
});

const jsonResponse = (
  description: string,
  schema: SchemaObject | OpenAPIV3_1.ReferenceObject,
): ResponseObject => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string): ResponseObject =>
  jsonResponse(description, ref('ErrorResponse'));

const unauthorized = errorResponse('Missing, malformed or expired access token.');

/**
 * OpenAPI wants one entry per parameter, where Zod produces a single object
 * schema. Doing the split by hand for `listAlertsQuerySchema`'s seven fields is
 * where a typo would live.
 */
function parametersFrom(schema: z.ZodType, location: 'query' | 'path'): ParameterObject[] {
  const { properties = {}, required = [] } = toOpenApiSchema(schema) as {
    properties?: Record<string, SchemaObject>;
    required?: string[];
  };

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    // A path parameter is part of the URL, so OpenAPI requires this regardless
    // of what the schema says.
    required: location === 'path' || required.includes(name),
    schema: property,
  }));
}

const rateLimited = (limit: number) =>
  errorResponse(`Rate limited: ${limit} requests per 15 minutes per IP.`);

export function buildOpenApiDocument(): OpenAPIV3_1.Document {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Exchange Monitor API',
      version: '0.1.0',
      description:
        'Currency rate alerts. Every schema below is generated from the Zod schemas that validate the requests, so it cannot drift from what the API actually accepts.',
    },

    // Relative, so "Try it out" calls the origin these docs were served from.
    // That is what makes `POST /auth/refresh` work in the browser: the refresh
    // cookie is `sameSite: 'strict'` and only rides along on a same-site request.
    servers: [{ url: '/' }],

    tags: [
      { name: 'auth', description: 'Registration, login and session lifetime.' },
      { name: 'alerts', description: 'Rate alerts belonging to the authenticated user.' },
      { name: 'currency', description: 'Live exchange rates, cached per pair.' },
      { name: 'system', description: 'Liveness.' },
    ],

    // The default; the five public and cookie-only operations override it.
    security: [{ bearerAuth: [] }],

    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refreshToken' },
      },
      schemas: toComponentSchemas() as Record<string, OpenAPIV3_1.SchemaObject>,
    },

    paths: {
      '/health': {
        get: {
          tags: ['system'],
          summary: 'Liveness probe',
          operationId: 'healthCheck',
          security: [],
          responses: {
            200: jsonResponse('The process is up.', {
              type: 'object',
              properties: { status: { type: 'string', examples: ['ok'] } },
              required: ['status'],
            }),
          },
        },
      },

      '/auth/register': {
        post: {
          tags: ['auth'],
          summary: 'Create an account and start a session',
          operationId: 'register',
          description:
            'Also sets the `refreshToken` cookie (httpOnly, `path=/auth`). The refresh token never appears in the body.',
          security: [],
          requestBody: jsonBody(registerSchema),
          responses: {
            201: jsonResponse('Account created.', ref('AuthResponse')),
            409: errorResponse('An account with this email already exists.'),
            422: errorResponse('Validation failed; `details` carries the field errors.'),
            429: rateLimited(10),
          },
        },
      },

      '/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Exchange credentials for a session',
          operationId: 'login',
          description:
            'Also sets the `refreshToken` cookie. A password that is too short is a wrong password (401), not a malformed request.',
          security: [],
          requestBody: jsonBody(loginSchema),
          responses: {
            200: jsonResponse('Signed in.', ref('AuthResponse')),
            401: errorResponse('Unknown email or wrong password.'),
            422: errorResponse('Validation failed; `details` carries the field errors.'),
            429: rateLimited(10),
          },
        },
      },

      '/auth/refresh': {
        post: {
          tags: ['auth'],
          summary: 'Rotate the session',
          operationId: 'refreshSession',
          description:
            'Takes no body: the credential is the `refreshToken` cookie, which is rotated on every call.\n\nThe **Authorize** dialog cannot set this cookie — nothing can, it is httpOnly. Log in through `POST /auth/login` in this same tab first and the browser will supply it.',
          security: [{ refreshCookie: [] }],
          responses: {
            200: jsonResponse('A fresh access token.', ref('SessionResponse')),
            401: errorResponse('The cookie is missing, expired, or was already rotated.'),
            429: rateLimited(60),
          },
        },
      },

      '/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'End the session',
          operationId: 'logout',
          description:
            'Deliberately not behind a bearer token, and deliberately 204 even without a cookie: the usual reason to log out is an access token that expired while the tab sat open.',
          security: [{ refreshCookie: [] }],
          responses: {
            204: { description: 'Session revoked and the cookie cleared.' },
          },
        },
      },

      '/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'The authenticated user',
          operationId: 'getCurrentUser',
          responses: {
            200: jsonResponse('The current user.', ref('MeResponse')),
            401: unauthorized,
          },
        },
      },

      '/alerts': {
        post: {
          tags: ['alerts'],
          summary: 'Create an alert',
          operationId: 'createAlert',
          // Not expressible in JSON Schema: a `.refine()` on the whole object.
          description:
            '`baseCurrency` and `quoteCurrency` must differ, which is a 422 rather than a schema violation.',
          requestBody: jsonBody(createAlertSchema),
          responses: {
            201: {
              ...jsonResponse('Alert created.', ref('AlertResponse')),
              headers: {
                Location: {
                  description: 'The new alert, as `/alerts/{id}`.',
                  schema: { type: 'string' },
                },
              },
            },
            401: unauthorized,
            409: errorResponse('An active alert for this pair, direction and rate already exists.'),
            422: errorResponse('Validation failed; `details` carries the field errors.'),
          },
        },
        get: {
          tags: ['alerts'],
          summary: 'List alerts',
          operationId: 'listAlerts',
          description:
            'Cursor paginated, newest first. Pass the previous page’s `nextCursor` as `cursor`; a `null` `nextCursor` is the last page.',
          parameters: parametersFrom(listAlertsQuerySchema, 'query'),
          responses: {
            200: jsonResponse('One page of alerts.', ref('AlertPage')),
            401: unauthorized,
            422: errorResponse('A query parameter is malformed.'),
          },
        },
      },

      '/alerts/{id}': {
        parameters: parametersFrom(alertIdParamSchema, 'path'),
        get: {
          tags: ['alerts'],
          summary: 'Fetch one alert',
          operationId: 'getAlert',
          responses: {
            200: jsonResponse('The alert.', ref('AlertResponse')),
            401: unauthorized,
            404: errorResponse('No such alert, or it belongs to someone else.'),
            422: errorResponse('`id` is not a uuid.'),
          },
        },
        patch: {
          tags: ['alerts'],
          summary: 'Update an alert',
          operationId: 'updateAlert',
          // Not expressible in JSON Schema: a `.refine()` on the whole object.
          description:
            'At least one field is required; an empty body is a 422. The pair is immutable — changing it makes a different alert, which is a POST plus a DELETE.',
          requestBody: jsonBody(updateAlertSchema),
          responses: {
            200: jsonResponse('The updated alert.', ref('AlertResponse')),
            401: unauthorized,
            404: errorResponse('No such alert, or it belongs to someone else.'),
            409: errorResponse('The change would duplicate another active alert.'),
            422: errorResponse('Validation failed, or `id` is not a uuid.'),
          },
        },
        delete: {
          tags: ['alerts'],
          summary: 'Delete an alert',
          operationId: 'deleteAlert',
          responses: {
            204: { description: 'Deleted.' },
            401: unauthorized,
            404: errorResponse('No such alert, or it belongs to someone else.'),
            422: errorResponse('`id` is not a uuid.'),
          },
        },
      },

      '/currency/{pair}': {
        get: {
          tags: ['currency'],
          summary: 'The live rate for a pair',
          operationId: 'getRate',
          description:
            'Rates are cached until the upstream’s own next update, so repeated calls for one pair cost a single upstream request per day.\n\nThe two codes must differ. A 404 means the upstream does not know one of them — it is not a cache miss and retrying will not help. A 503 means the upstream quota ran out; that one is worth retrying later.',
          parameters: parametersFrom(currencyPairParamSchema, 'path'),
          responses: {
            200: jsonResponse('The current rate.', ref('CurrencyRateResponse')),
            401: unauthorized,
            404: errorResponse('The upstream does not support one of the two codes.'),
            422: errorResponse('`pair` is malformed, or the two codes are the same.'),
            502: errorResponse('The upstream is unreachable or answered with something unusable.'),
            503: errorResponse('The upstream quota is exhausted. Retry later.'),
          },
        },
      },
    },
  };
}
