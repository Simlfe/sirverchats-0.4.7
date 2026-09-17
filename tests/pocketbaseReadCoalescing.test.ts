import test from 'node:test';
import assert from 'node:assert/strict';
import { pbService } from '../src/pocketbase';

test('same-message reads share one missing-record request and then use the record cache', async () => {
  const service = pbService as any;
  const originalPb = service.pb;
  const originalDemo = service.isDemo;
  service.isDemo = false;
  service.messageRecordCache.clear();
  service.messageRecordCachedAt.clear();
  service.messageReadPromises.clear();
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  service.pb = {
    collection() {
      return {
        async getOne() {
          reads += 1;
          await gate;
          return {
            id: 'm-coalesce',
            sender: 'u-1',
            channel: 'c-1',
            content: 'cached preview',
            created: '2026-01-01T00:00:00.000Z',
          };
        },
      };
    },
    cancelRequest() {},
  };

  try {
    const first = pbService.getMessageById('m-coalesce');
    const second = pbService.getMessageById('m-coalesce');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    const cached = await pbService.getMessageById('m-coalesce');
    assert.equal(cached, a);
    assert.equal(reads, 1);
  } finally {
    service.pb = originalPb;
    service.isDemo = originalDemo;
    service.messageRecordCache.clear();
    service.messageRecordCachedAt.clear();
    service.messageReadPromises.clear();
  }
});

test('concurrent server-role consumers share one PocketBase list request', async () => {
  const service = pbService as any;
  const originalPb = service.pb;
  const originalDemo = service.isDemo;
  service.isDemo = false;
  service.serverRolesSnapshotCache.clear();
  service.serverRolesPromises.clear();
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  service.pb = {
    collection() {
      return {
        async getFullList() {
          reads += 1;
          await gate;
          return [{ id: 'r-1', server: 's-1', name: 'Member' }];
        },
      };
    },
  };

  try {
    const first = pbService.fetchServerRoles('s-1');
    const second = pbService.fetchServerRoles('s-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reads, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(a[0].id, 'r-1');
    await pbService.fetchServerRoles('s-1');
    assert.equal(reads, 1);
  } finally {
    service.pb = originalPb;
    service.isDemo = originalDemo;
    service.serverRolesSnapshotCache.clear();
    service.serverRolesPromises.clear();
  }
});
