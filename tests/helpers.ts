import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FetchLike } from '../src/http.js';

export type FugleFixtureMap = Record<string, Record<string, unknown>>;

export async function fixtureMap(): Promise<FugleFixtureMap> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'tests/fixtures/fugle-synthetic-valid.json'), 'utf8')) as FugleFixtureMap;
}

export function fixtureKey(url: URL): string {
  const symbol = url.pathname.split('/').at(-1);
  const timeframe = url.searchParams.get('timeframe');
  const adjustment = url.searchParams.get('adjusted') === 'true' ? 'adjusted' : 'raw';
  return `${symbol}-${timeframe}-${adjustment}`;
}

export function fixtureFetch(fixtures: FugleFixtureMap, requests: URL[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    const body = fixtures[fixtureKey(url)];
    if (!body) return new Response('', { status: 404 });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (requests.length === 1) headers.set('x-ratelimit-remaining', '59');
    if ((init?.headers as Record<string, string> | undefined)?.['X-API-KEY'] === undefined) return new Response('', { status: 401 });
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
}
