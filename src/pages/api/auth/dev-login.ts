import type { NextApiRequest, NextApiResponse } from 'next';

import { db } from '~/server/db';

/**
 * Custom API route for dev login that bypasses the credentials form.
 * Creates/finds a dev user and returns a session token.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const email = (req.body.email as string) ?? 'dev@example.com';

    // Find or create dev user
    let user = await db.user.findUnique({ where: { email } });
    if (!user) {
      user = await db.user.create({
        data: {
          email,
          name: email.split('@')[0],
          emailVerified: new Date(),
        },
      });
    }

    // Return user info for the client to use with next-auth signIn
    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error('Dev login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
