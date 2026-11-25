/**
 * Echo Life Phase 3 + 4 — the game's server link (`/api/v1/echo-life/game`, V130), separate from the V129 world save.
 *
 * - The narrative document (V3 save + residents' places) is written debounced, with the revision it was based on.
 *   A conflict restores the server revision, including any checkout another tab committed at the same game minute.
 * - Economy reports (claims) and purchases go one at a time; the server's wallet in each answer is authoritative and is
 *   applied over whatever V3 showed (`onWallet`). A report that could not be sent stays queued and is sent again.
 * Scoped to the signed-in account by the server; nothing here names a user.
 */
import { apiClient } from '@/services/api-client';
import type { ClaimBatch, GameDoc, Wallet } from './session';

export interface GameRecord { saveVersion: number; revision: number; doc: GameDoc | null; wallet: Wallet & { level?: number; dailyCredits?: number; dailyXp?: number }; updatedAt: string | null }
export interface ClaimResult { wallet: Wallet; granted: string[]; refused: Record<string, string>; activityCredits: number; activityXp: number; revision?: number | null }
export interface PurchaseResult { wallet: Wallet; instanceId: string; price: number; itemType: string }
export interface SaleResult { wallet: Wallet; refund: number }

export type WorkshopAction = {type:string;jobId?:string;station?:string;instanceId?:string;componentId?:string;slot?:string;propertyId?:string;upgradeId?:string;zoneId?:string;styleId?:string;finishId?:string;x?:number;z?:number;yaw?:number;delta?:number};
export interface GameApi {
  configure(action: WorkshopAction, revision:number, requestId:string): Promise<{ok:boolean;msg:string;wallet:Wallet}>;
  get(): Promise<GameRecord>;
  put(doc: GameDoc, revision: number): Promise<GameRecord>;
  claims(batches: ClaimBatch[], checkout?: {doc: GameDoc; revision: number}): Promise<ClaimResult>;
  purchase(storeId: string, sku: string, requestId: string): Promise<PurchaseResult>;
  sell(instanceId: string): Promise<SaleResult>;
}

type Fail = { status: number; code?: string; current?: GameRecord };
const fail = (e: { response?: { status?: number; data?: { code?: string; current?: GameRecord } } }): Fail =>
  ({ status: e.response?.status ?? 0, code: e.response?.data?.code, current: e.response?.data?.current });

export const echoLifeGameApi: GameApi = {
  configure: (action,revision,requestId) => apiClient.post<{ok:boolean;msg:string;wallet:Wallet}>('/echo-life/game/workshop',{action,revision,requestId}).then(r=>r.data).catch(e=>{throw fail(e);}),
  get: () => apiClient.get<GameRecord>('/echo-life/game').then(r => r.data),
  put: (doc, revision) => apiClient.put<GameRecord>('/echo-life/game', { doc, revision }).then(r => r.data).catch(e => { throw fail(e); }),
  claims: (batches, checkout) => apiClient.post<ClaimResult>('/echo-life/game/claims', { batches, checkout }).then(r => r.data).catch(e => { throw fail(e); }),
  purchase: (storeId, sku, requestId) => apiClient.post<PurchaseResult>('/echo-life/game/purchases', { storeId, sku, requestId }).then(r => r.data).catch(e => { throw fail(e); }),
  sell: instanceId => apiClient.post<SaleResult>('/echo-life/game/sales', { instanceId }).then(r => r.data).catch(e => { throw fail(e); }),
};

export class GameSaver {
  doc: GameDoc | null = null;
  wallet: Wallet | null = null;
  revision = 0;
  loaded = false;
  failed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private claimRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private claimRetryAttempt = 0;
  private saveRetryAttempt = 0;
  private source: (() => GameDoc | null) | null = null;
  private saving: Promise<void> = Promise.resolve();
  private claimQueue: ClaimBatch[] = [];
  private claiming: Promise<void> = Promise.resolve();
  private disposed = false;
  private atRegister = false;
  private storyGeneration = 0;
  onWallet: ((w: Wallet) => void) | null = null;
  onNewer: ((doc: GameDoc) => void) | null = null;
  onRefused: ((key: string, why: string) => void) | null = null;
  /** QA telemetry (read by journeys). */
  stats = { saves: 0, conflicts: 0, claims: 0, granted: 0, refused: 0, errors: 0 };

  constructor(private readonly api: GameApi, readonly account: string) {}

  /** The V3 owner of this account's game (the server binds it to the principal the same way). */
  get owner() { return 'u' + this.account; }

  async load(): Promise<void> {
    try {
      const r = await this.api.get();
      if (this.disposed) return;
      this.doc = r.doc; this.revision = r.revision; this.wallet = r.wallet;
      this.loaded = true;
    } catch {
      this.failed = true;
    }
  }

  /** Save (debounced) whatever `source` returns. */
  schedule(source: () => GameDoc | null, delay = 4000) {
    if (this.failed || this.disposed) return;
    this.source = source;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const doc = this.source?.();
    if (!doc || !this.loaded || this.atRegister) return this.saving;
    const generation = this.storyGeneration;
    this.saving = this.saving.catch(() => undefined).then(() => {
      if (generation === this.storyGeneration) return this.write(doc);
    });
    return this.saving;
  }

  private async write(doc: GameDoc): Promise<void> {
    try {
      const r = await this.api.put(doc, this.revision);
      this.revision = r.revision; this.doc = doc; this.stats.saves++; this.saveRetryAttempt = 0;
      // Narrative writes may finish after a newer economy operation. Its wallet is already delivered by the economy endpoints.
    } catch (e) {
      const f = e as Fail;
      if (f.status === 409 && f.current?.doc) {
        this.stats.conflicts++;
        this.saveRetryAttempt = 0;
        this.revision = f.current.revision;
        this.doc = f.current.doc;
        this.storyGeneration++;
        this.applyWallet(f.current.wallet);
        this.onNewer?.(f.current.doc);
        return;
      }
      this.stats.errors++;
      if (!this.disposed && (f.status === 0 || f.status === 429 || f.status >= 500) && this.source) {
        const waitMs = Math.round(Math.min(30000, 4000 * Math.pow(2, Math.min(this.saveRetryAttempt++, 3))) * (0.85 + Math.random() * 0.3));
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, waitMs);
      }
    }
  }

  /** Report economy changes; the server's wallet comes back and is applied. */
  report(batches: ClaimBatch[]) {
    if (!batches.length && !this.claimQueue.length) return this.claiming;
    this.claimQueue.push(...batches.map(b=>({...b,requestId:b.requestId ?? crypto.randomUUID()})));
    this.claiming = this.claiming.catch(() => undefined).then(() => this.sendClaims());
    return this.claiming;
  }

  private async sendClaims() {
    while (this.claimQueue.length && !this.disposed) {
      const batch = this.claimQueue.slice(0, 32);
      try {
        const r = await this.api.claims(batch);
        this.claimQueue.splice(0, batch.length);
        this.claimRetryAttempt = 0;
        this.stats.claims += batch.length; this.stats.granted += r.granted.length;
        for (const [k, why] of Object.entries(r.refused)) { this.stats.refused++; this.onRefused?.(k, why); }
        this.applyWallet(r.wallet);
      } catch (e) {
        const f = e as Fail;
        this.stats.errors++;
        // A refused request (4xx) is dropped; a network or server failure keeps the reports and schedules exponential retry.
        if (f.status >= 400 && f.status < 500 && f.status !== 429) {
          this.claimQueue.splice(0, batch.length);
        } else {
          if (!this.disposed && !this.claimRetryTimer) {
            const waitMs = Math.round(Math.min(30000, 3000 * Math.pow(2, Math.min(this.claimRetryAttempt++, 3))) * (0.85 + Math.random() * 0.3));
            this.claimRetryTimer = setTimeout(() => { this.claimRetryTimer = null; void this.report([]); }, waitMs);
          }
          return;
        }
      }
    }
  }

  async checkout(doc: GameDoc, batch: ClaimBatch): Promise<Wallet> {
    if (this.atRegister || !this.loaded) throw Error('The register is busy.');
    this.atRegister = true;
    try {
      const generation = this.storyGeneration;
      await this.saving;
      await this.claiming;
      if (this.disposed || this.storyGeneration !== generation) throw Error('Reopen the register in your current game.');
      if (this.claimQueue.length) throw Error('Reconnect before paying.');
      const snapshot = { doc, revision: this.revision };
      const batches = [{...batch, requestId: crypto.randomUUID()}];
      const send = () => this.api.claims(batches, snapshot);
      let paid: ClaimResult;
      try {
        paid = await send().catch(e => {
          if ((e as Fail).status >= 400 && (e as Fail).status < 500) throw e;
          return send();
        });
      } catch (e) {
        const failure = e as Fail;
        const current = failure.current ?? await this.api.get().catch(() => null);
        if (current) {
          this.revision = current.revision; this.doc = current.doc;
          this.applyWallet(current.wallet);
          if (current.doc) this.onNewer?.(current.doc);
        } else {
          this.loaded = false;
        }
        throw Error(failure.code === 'INSUFFICIENT_CREDITS' ? 'Insufficient Campus Credits.' :
          current ? 'Your game was refreshed. Check your basket before paying again.' : 'Reconnect and reload to check your payment.');
      }
      if (paid.revision == null) throw Error('The register returned an incomplete receipt.');
      this.revision = paid.revision;
      this.doc = doc;
      this.wallet = paid.wallet;
      return paid.wallet;
    } finally {
      this.atRegister = false;
    }
  }

  async purchase(storeId: string, sku: string): Promise<PurchaseResult | { error: string }> {
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    try {
      const r = await this.api.purchase(storeId, sku, requestId);
      this.applyWallet(r.wallet);
      return r;
    } catch (e) {
      return { error: (e as Fail).code ?? 'NETWORK' };
    }
  }

  async configure(action:WorkshopAction) {
    try {
      const r=await this.api.configure(action,this.wallet?.workshopRevision ?? 0,crypto.randomUUID());
      this.applyWallet(r.wallet);
      return r;
    } catch(e) {
      const failure=e as Fail;
      if (failure.current) this.applyWallet(failure.current.wallet);
      return {ok:false,msg:failure.code === 'STALE_REVISION' ? 'Your workshop changed in another tab. Review the current items and try again.' : 'Could not save this change.'};
    }
  }

  async sell(instanceId: string): Promise<SaleResult | { error: string }> {
    try {
      const r = await this.api.sell(instanceId);
      this.applyWallet(r.wallet);
      return r;
    } catch (e) {
      return { error: (e as Fail).code ?? 'NETWORK' };
    }
  }

  private applyWallet(w: Wallet) { if (this.disposed) return; this.wallet = w; this.onWallet?.(w); }

  preserveUnreadableSave() {
    this.loaded = false;
    this.failed = true;
    this.storyGeneration++;
    this.source = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.claimRetryTimer) clearTimeout(this.claimRetryTimer);
  }
}
