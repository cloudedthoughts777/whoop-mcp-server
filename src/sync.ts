import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';

interface SyncStats {
	cycles: number;
	recoveries: number;
	sleeps: number;
	workouts: number;
}

interface SmartSyncResult {
	type: 'full' | 'quick' | 'skip';
	stats?: SyncStats;
}

export class WhoopSync {
	private readonly client: WhoopClient;
	private readonly db: WhoopDatabase;

	constructor(client: WhoopClient, db: WhoopDatabase) {
		this.client = client;
		this.db = db;
	}

	async syncDays(days = 90): Promise<SyncStats> {
		const endDate = new Date();
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - days);

		const start = startDate.toISOString();
		const end = endDate.toISOString();

		const fetchOne = async <T>(label: string, p: Promise<T[]>): Promise<T[]> => {
			try {
				return await p;
			} catch (err) {
				process.stderr.write(`[sync] fetch ${label} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
				return [];
			}
		};

		const [cycles, recoveries, sleeps, workouts] = await Promise.all([
			fetchOne('cycles', this.client.getAllCycles({ start, end })),
			fetchOne('recoveries', this.client.getAllRecoveries({ start, end })),
			fetchOne('sleeps', this.client.getAllSleeps({ start, end })),
			fetchOne('workouts', this.client.getAllWorkouts({ start, end })),
		]);

		const upsertSafe = (label: string, fn: () => void): void => {
			try {
				fn();
			} catch (err) {
				process.stderr.write(`[sync] upsert ${label} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
			}
		};

		if (cycles.length > 0) upsertSafe('cycles', () => this.db.upsertCycles(cycles));
		if (recoveries.length > 0) upsertSafe('recoveries', () => this.db.upsertRecoveries(recoveries));
		if (sleeps.length > 0) upsertSafe('sleeps', () => this.db.upsertSleeps(sleeps));
		if (workouts.length > 0) upsertSafe('workouts', () => this.db.upsertWorkouts(workouts));

		this.db.updateSyncState(
			startDate.toISOString().split('T')[0],
			endDate.toISOString().split('T')[0]
		);

		return {
			cycles: cycles.length,
			recoveries: recoveries.length,
			sleeps: sleeps.length,
			workouts: workouts.length,
		};
	}

	async quickSync(): Promise<SyncStats> {
		return this.syncDays(7);
	}

	needsFullSync(): boolean {
		const state = this.db.getSyncState();
		if (!state.lastSyncAt) return true;

		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
		return hoursSinceSync > 24;
	}

	async smartSync(): Promise<SmartSyncResult> {
		const state = this.db.getSyncState();

		if (!state.lastSyncAt) {
			const stats = await this.syncDays(90);
			return { type: 'full', stats };
		}

		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

		if (hoursSinceSync < 1) {
			return { type: 'skip' };
		}

		const stats = await this.quickSync();
		return { type: 'quick', stats };
	}
}
