import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactionRulesApi } from './interactionRules';

function mockFetchOnce(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

describe('interactionRules API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('interactionRulesApi.list GETs /interaction-rules', async () => {
    mockFetchOnce([
      {
        id: 'rule1',
        actionType: 'songRequest',
        enabled: true,
        minAmount: 5,
        commandKeyword: 'sr',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'rule2',
        actionType: 'songRequest',
        enabled: false,
        minAmount: 10,
        commandKeyword: 'songrequest',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    const rules = await interactionRulesApi.list();
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('rule1');
    expect(rules[0].commandKeyword).toBe('sr');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/interaction-rules');
  });

  it('interactionRulesApi.create POSTs to /interaction-rules', async () => {
    mockFetchOnce({
      id: 'rule1',
      actionType: 'songRequest',
      enabled: true,
      minAmount: 5,
      commandKeyword: 'sr',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const rule = await interactionRulesApi.create({
      actionType: 'songRequest',
      enabled: true,
      minAmount: 5,
      commandKeyword: 'sr',
    });
    expect(rule.id).toBe('rule1');
    expect(rule.commandKeyword).toBe('sr');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/interaction-rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      actionType: 'songRequest',
      enabled: true,
      minAmount: 5,
      commandKeyword: 'sr',
    });
  });

  it('interactionRulesApi.update PUTs to /interaction-rules/{id}', async () => {
    mockFetchOnce({
      id: 'rule1',
      actionType: 'songRequest',
      enabled: false,
      minAmount: 10,
      commandKeyword: 'sr',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    const rule = await interactionRulesApi.update('rule1', {
      actionType: 'songRequest',
      enabled: false,
      minAmount: 10,
      commandKeyword: 'sr',
    });
    expect(rule.id).toBe('rule1');
    expect(rule.enabled).toBe(false);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/interaction-rules/rule1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      actionType: 'songRequest',
      enabled: false,
      minAmount: 10,
      commandKeyword: 'sr',
    });
  });

  it('interactionRulesApi.remove DELETEs /interaction-rules/{id}', async () => {
    mockFetchOnce({});
    await interactionRulesApi.remove('rule1');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/interaction-rules/rule1');
    expect(init.method).toBe('DELETE');
  });
});
