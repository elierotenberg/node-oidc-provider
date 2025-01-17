/* eslint-disable no-console, max-len, camelcase, no-unused-vars */
const { strict: assert } = require('assert');
const querystring = require('querystring');
const crypto = require('crypto');
const { inspect } = require('util');

const _ = require('lodash');
const bodyParser = require('koa-body');
const Router = require('koa-router');

const { renderError } = require('../../lib/helpers/defaults'); // make your own, you'll need it anyway
const Account = require('../support/account');

const keys = new Set();
const debug = obj => querystring.stringify(Object.entries(obj).reduce((acc, [key, value]) => {
  keys.add(key);
  if (_.isEmpty(value)) return acc;
  acc[key] = inspect(value, { depth: null });
  return acc;
}, {}), '<br/>', ': ', {
  encodeURIComponent(value) { return keys.has(value) ? `<strong>${value}</strong>` : value; },
});

module.exports = (provider) => {
  const router = new Router();
  const { constructor: { errors: { SessionNotFound } } } = provider;

  router.use(async (ctx, next) => {
    ctx.set('Pragma', 'no-cache');
    ctx.set('Cache-Control', 'no-cache, no-store');
    try {
      await next();
    } catch (err) {
      if (err instanceof SessionNotFound) {
        ctx.status = err.status;
        const { message: error, error_description } = err;
        renderError(ctx, { error, error_description }, err);
      } else {
        throw err;
      }
    }
  });

  router.get('/interaction/:uid', async (ctx, next) => {
    const {
      uid, prompt, params, session,
    } = await provider.interactionDetails(ctx.req);
    const client = await provider.Client.find(params.client_id);
    if (prompt.name === 'login') {
      await ctx.render('login', {
        client,
        uid,
        details: prompt.details,
        params,
        title: 'Sign-in',
        google: ctx.google,
        session: session ? debug(session) : undefined,
        dbg: {
          params: debug(params),
          prompt: debug(prompt),
        },
      });
    } else {
      await ctx.render('interaction', {
        client,
        uid,
        details: prompt.details,
        params,
        title: 'Authorize',
        session: session ? debug(session) : undefined,
        dbg: {
          params: debug(params),
          prompt: debug(prompt),
        },
      });
    }

    await next();
  });

  const body = bodyParser({
    text: false, json: false, patchNode: true, patchKoa: true,
  });

  router.get('/interaction/callback/google', ctx => ctx.render('repost', { provider: 'google', layout: false }));

  router.post('/interaction/:uid/login', body, async (ctx) => {
    const { prompt: { name } } = await provider.interactionDetails(ctx.req);
    assert.equal(name, 'login');

    const account = await Account.findByLogin(ctx.request.body.login);

    const result = {
      login: {
        account: account.accountId,
        ts: Math.floor(Date.now() / 1000),
      },
    };

    return provider.interactionFinished(ctx.req, ctx.res, result, {
      mergeWithLastSubmission: false,
    });
  });

  router.post('/interaction/:uid/federated', body, async (ctx) => {
    const { prompt: { name } } = await provider.interactionDetails(ctx.req);
    assert.equal(name, 'login');

    const path = `/interaction/${ctx.params.uid}/federated`;
    const callbackParams = ctx.google.callbackParams(ctx.req);

    switch (ctx.request.body.provider) {
      case 'google': {
        if (Object.keys(callbackParams).length) {
          const state = ctx.cookies.get('google.state');
          ctx.cookies.set('google.state', null, { path });
          const nonce = ctx.cookies.get('google.nonce');
          ctx.cookies.set('google.nonce', null, { path });

          const tokenset = await ctx.google.callback(undefined, callbackParams, { state, nonce, response_type: 'id_token' });
          const account = await Account.findByFederated('google', tokenset.claims());

          const result = {
            login: {
              account: account.accountId,
              ts: Math.floor(Date.now() / 1000),
            },
          };
          return provider.interactionFinished(ctx.req, ctx.res, result, {
            mergeWithLastSubmission: false,
          });
        }

        const state = `${ctx.params.uid}|${crypto.randomBytes(32).toString('hex')}`;
        const nonce = crypto.randomBytes(32).toString('hex');

        ctx.cookies.set('google.state', state, { path, sameSite: 'strict' });
        ctx.cookies.set('google.nonce', nonce, { path, sameSite: 'strict' });

        return ctx.redirect(ctx.google.authorizationUrl({
          state, nonce, scope: 'openid email profile',
        }));
      }
      default:
        return undefined;
    }
  });

  router.post('/interaction/:uid/confirm', body, async (ctx) => {
    const { prompt: { name, details } } = await provider.interactionDetails(ctx.req);
    assert.equal(name, 'consent');

    const consent = {};

    // any scopes you do not wish to grant go in here
    //   otherwise details.scopes.new.concat(details.scopes.accepted) will be granted
    consent.rejectedScopes = [];

    // any claims you do not wish to grant go in here
    //   otherwise all claims mapped to granted scopes
    //   and details.claims.new.concat(details.claims.accepted) will be granted
    consent.rejectedClaims = [];

    // replace = false means previously rejected scopes and claims remain rejected
    // changing this to true will remove those rejections in favour of just what you rejected above
    consent.replace = false;

    const result = { consent };
    return provider.interactionFinished(ctx.req, ctx.res, result, {
      mergeWithLastSubmission: true,
    });
  });

  router.get('/interaction/:uid/abort', async (ctx) => {
    const result = {
      error: 'access_denied',
      error_description: 'End-User aborted interaction',
    };

    return provider.interactionFinished(ctx.req, ctx.res, result, {
      mergeWithLastSubmission: false,
    });
  });

  return router;
};
