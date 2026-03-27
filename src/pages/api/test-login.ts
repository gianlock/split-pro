import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '~/server/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const email = req.query.email as string;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  // Find or create user
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

  // Redirect to sign in with this email
  const csrfResponse = await fetch(`${process.env.NEXTAUTH_URL}/api/auth/csrf`);
  const { csrfToken } = await csrfResponse.json();

  // Build form to auto-submit
  const html = `<!DOCTYPE html>
<html>
<head><title>Logging in...</title></head>
<body>
<form method="POST" action="${process.env.NEXTAUTH_URL}/api/auth/callback/dev">
<input type="hidden" name="csrfToken" value="${csrfToken}">
<input type="hidden" name="email" value="${email}">
<input type="hidden" name="callbackUrl" value="/balances">
</form>
<script>document.forms[0].submit();</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}
