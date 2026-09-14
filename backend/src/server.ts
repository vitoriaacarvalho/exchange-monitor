import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './prisma/db.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function deleteExpiredRefreshTokens(): Promise<void> {
  try {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (count > 0) {
      console.log(`[cleanup] deleted ${count} expired refresh token(s)`);
    }
  } catch (error) {
    // A failed sweep is not a reason to take the server down; rows that outlive
    // their expiry are already rejected on use.
    console.error('[cleanup] sweep failed', error);
  }
}

app.listen(env.PORT, () => {
  console.log(`server running on port ${env.PORT}`);
});

// A cron job's work, done in-process until there is somewhere to deploy a cron.
// `unref` so the interval never holds the process open on its own.
setInterval(() => void deleteExpiredRefreshTokens(), CLEANUP_INTERVAL_MS).unref();
