import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../openapi/document.js';

const router = Router();

// Built once at module load: the document is a pure function of code that
// cannot change while the process runs.
const document = buildOpenApiDocument();

// Ahead of the UI mount so it stays reachable even if the bundled assets fail
// to load. Also what the SPA would run a client generator against.
router.get('/openapi.json', (_req, res) => {
  res.status(200).json(document);
});

router.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(document, { customSiteTitle: 'Exchange Monitor API' }),
);

export { router as docsRoutes };
