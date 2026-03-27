import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { type GetServerSidePropsContext } from 'next';
import { type DefaultSession, type NextAuthOptions, type User, getServerSession } from 'next-auth';
import { type Adapter, type AdapterAccount, type AdapterUser } from 'next-auth/adapters';
import AuthentikProvider from 'next-auth/providers/authentik';
import CredentialsProvider from 'next-auth/providers/credentials';
import EmailProvider from 'next-auth/providers/email';
import GoogleProvider from 'next-auth/providers/google';
import KeycloakProvider from 'next-auth/providers/keycloak';

import { env } from '~/env';
import { db } from '~/server/db';

import { sendSignUpEmail } from './mailer';
import { getBaseUrl } from '~/utils/api';
import type { OAuthConfig } from 'next-auth/providers/oauth';

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module 'next-auth' {
  interface Session extends DefaultSession {
    user: DefaultSession['user'] & {
      id: number;
      currency: string;
      obapiProviderId?: string;
      bankingId?: string;
      preferredLanguage: string;
      hiddenFriendIds: number[];
      // ...other properties
      // Role: UserRole;
    };
  }

  interface User {
    id: number;
    name: string;
    email: string;
    image: string;
    currency: string;
    obapiProviderId?: string;
    bankingId?: string;
    preferredLanguage: string;
    hiddenFriendIds: number[];
  }
}

const SplitProPrismaAdapter = (...args: Parameters<typeof PrismaAdapter>): Adapter => {
  const prismaAdapter = PrismaAdapter(...args);

  return {
    ...prismaAdapter,
    createUser: (user: Omit<AdapterUser, 'id'>): Promise<AdapterUser> => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      const prismaCreateUser = prismaAdapter.createUser;

      if (env.INVITE_ONLY) {
        throw new Error('This instance is Invite Only');
      }

      if (!prismaCreateUser) {
        // This should never happen but typing says it's possible.
        throw new Error('Prisma Adapter lacks User Creation');
      }

      // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-call
      return prismaCreateUser(user);
    },
    linkAccount: async (account: AdapterAccount) => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      const originalLinkAccount = prismaAdapter.linkAccount;

      if (!originalLinkAccount) {
        throw new Error('Adapter is missing the linkAccount method.');
      }

      // Keycloak and Gitlab provide some non-standard fields that do not exist in the prisma schema.
      // We strip them out before passing them on to the original adapter.
      if (account.provider === 'keycloak') {
        const {
          'not-before-policy': _notBeforePolicy,
          refresh_expires_in: _refresh_expires_in,
          ...standardAccountData
        } = account as AdapterAccount & Record<string, unknown>;

        return originalLinkAccount(standardAccountData as AdapterAccount);
      } else if (account.provider === 'gitlab') {
        const { created_at: _createdAt, ...standardAccountData } = account as AdapterAccount &
          Record<string, unknown>;

        return originalLinkAccount(standardAccountData as AdapterAccount);
      }

      // Default: proceed directly
      return originalLinkAccount(account);
    },
  } as Adapter;
};

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions: NextAuthOptions = {
  pages: {
    signIn: '/auth/signin',
  },
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    session: ({ session, token }) => ({
      ...session,
      user: {
        ...session.user,
        id: typeof token.sub === 'string' ? parseInt(token.sub, 10) : (token.sub ?? 0),
        currency: (token.currency as string) ?? 'USD',
        obapiProviderId: token.obapiProviderId as string | undefined,
        bankingId: token.bankingId as string | undefined,
        preferredLanguage: (token.preferredLanguage as string) ?? '',
        hiddenFriendIds: (token.hiddenFriendIds as number[]) ?? [],
      },
    }),
    async signIn({ user, email }) {
      if (email?.verificationRequest && env.DISABLE_EMAIL_SIGNUP) {
        const existingUser = await db.user.findUnique({
          where: { email: user.email },
        });

        if (!existingUser) {
          return `${getBaseUrl()}/auth/signin?error=SignupDisabled`;
        }
      }

      return true;
    },
    async jwt({ token, user, account: _account }) {
      if (user) {
        // Fetch full user data from database
        const userId = typeof user.id === 'string' ? parseInt(user.id, 10) : user.id;
        const dbUser = await db.user.findUnique({
          where: { id: userId },
        });
        if (dbUser) {
          token.currency = dbUser.currency;
          token.obapiProviderId = dbUser.obapiProviderId;
          token.bankingId = dbUser.bankingId;
          token.preferredLanguage = dbUser.preferredLanguage;
          token.hiddenFriendIds = dbUser.hiddenFriendIds;
        }
      }
      return token;
    },
  },
  adapter: SplitProPrismaAdapter(db),
  providers: getProviders(),
  events: {
    createUser: async ({ user }) => {
      // Check if the user's name is empty
      if ((!user.name || '' === user.name.trim()) && user.email) {
        // Define the logic to update the user's name here
        const [updatedName] = user.email.split('@');

        // Use your database client to update the user's name
        await db.user.update({
          where: { id: user.id },
          data: { name: updatedName },
        });
      }
    },
  },
};

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export const getServerAuthSession = (ctx: {
  req: GetServerSidePropsContext['req'];
  res: GetServerSidePropsContext['res'];
}) => getServerSession(ctx.req, ctx.res, authOptions);

export const getServerAuthSessionForSSG = async (context: GetServerSidePropsContext) => {
  console.log('Before getting session');
  const session = await getServerAuthSession(context);
  console.log('After getting session');

  if (!session?.user?.email) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }

  return {
    props: {
      user: session.user,
    },
  };
};

/**
 * Get providers to enable
 */
function getProviders() {
  const providersList = [];

  // Development-only credentials provider for easy local testing
  if (env.NODE_ENV === 'development' && !process.env.DISABLE_DEV_AUTH) {
    providersList.push(
      CredentialsProvider({
        id: 'dev',
        name: 'Dev Login',
        credentials: {
          email: {
            label: 'Email',
            type: 'email',
            placeholder: 'dev@example.com',
            value: 'dev@example.com',
          },
        },
        async authorize(credentials, req) {
          // Use email from credentials, or default to dev@example.com
          const email = (credentials?.email as string) ?? 'dev@example.com';
          // Find or create a dev user
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
          // Return user - next-auth will pass to session callback
          return {
            id: user.id,
            email: user.email ?? email,
            name: user.name ?? email.split('@')[0],
            image: user.image ?? null,
            currency: user.currency,
            preferredLanguage: user.preferredLanguage,
            hiddenFriendIds: user.hiddenFriendIds,
          } as unknown as User;
        },
      }),
    );
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providersList.push(
      GoogleProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (env.EMAIL_SERVER_HOST) {
    providersList.push(
      EmailProvider({
        from: env.FROM_EMAIL,
        server: {
          host: env.EMAIL_SERVER_HOST,
          port: parseInt(env.EMAIL_SERVER_PORT ?? ''),
          auth: {
            user: env.EMAIL_SERVER_USER,
            pass: env.EMAIL_SERVER_PASSWORD,
          },
        },
        async sendVerificationRequest({ identifier: email, url, token }) {
          const result = await sendSignUpEmail(email, url, token);
          if (!result) {
            throw new Error('Failed to send email');
          }
        },
        generateVerificationToken() {
          return Math.random().toString(36).substring(2, 7).toLowerCase();
        },
      }),
    );
  }

  if (env.AUTHENTIK_ID && env.AUTHENTIK_SECRET && env.AUTHENTIK_ISSUER) {
    providersList.push(
      AuthentikProvider({
        clientId: env.AUTHENTIK_ID,
        clientSecret: env.AUTHENTIK_SECRET,
        issuer: env.AUTHENTIK_ISSUER,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (env.KEYCLOAK_ID && env.KEYCLOAK_SECRET && env.KEYCLOAK_ISSUER) {
    providersList.push(
      KeycloakProvider({
        clientId: env.KEYCLOAK_ID,
        clientSecret: env.KEYCLOAK_SECRET,
        issuer: env.KEYCLOAK_ISSUER,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_WELL_KNOWN_URL) {
    providersList.push({
      id: env.OIDC_NAME?.toLowerCase() ?? 'oidc',
      name: env.OIDC_NAME ?? 'OIDC',
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      type: 'oauth',
      wellKnown: env.OIDC_WELL_KNOWN_URL,
      authorization: { params: { scope: 'openid email profile' } },
      allowDangerousEmailAccountLinking: env.OIDC_ALLOW_DANGEROUS_EMAIL_LINKING,
      idToken: true,
      profile(profile) {
        // This function expects a "standard" next-auth user but we override
        // What a next-auth user is above.  The expected next-auth user must be
        // A record that has an id, a name, an email, and an image.
        //
        // To work around this, we case to unknown and then `User`.
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
        } as unknown as User;
      },
    } satisfies OAuthConfig<{
      sub: string;
      name: string;
      email: string;
      picture: string;
      preferred_username: string;
    }>);
  }

  return providersList;
}

/**
 * Validates the environment variables that are related to authentication.
 * this will check if atleat one provider is set properly.
 *
 * this function should be updated if new providers are added.
 */
export function validateAuthEnv() {
  console.log('Validating auth env');
  if (!process.env.SKIP_ENV_VALIDATION) {
    const providers = getProviders();
    if (0 === providers.length) {
      throw new Error(
        'No authentication providers are configured, at least one is required. Learn more here: https://github.com/oss-apps/split-pro?tab=readme-ov-file#setting-up-the-environment',
      );
    }
  }
}
