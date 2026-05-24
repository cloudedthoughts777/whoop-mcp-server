import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
	workout_id?: string;
}

const SPORT_NAMES: Record<number, string> = {
	0: 'Running', 1: 'Cycling', 16: 'Baseball', 17: 'Basketball', 18: 'Rowing',
	19: 'Fencing', 20: 'Field Hockey', 21: 'Football', 22: 'Golf', 24: 'Ice Hockey',
	25: 'Lacrosse', 27: 'Rugby', 28: 'Sailing', 29: 'Skiing', 30: 'Soccer',
	31: 'Softball', 32: 'Squash', 33: 'Swimming', 34: 'Tennis', 35: 'Track & Field',
	36: 'Volleyball', 37: 'Water Polo', 38: 'Wrestling', 39: 'Boxing', 42: 'Dance',
	43: 'Pilates', 44: 'Yoga', 45: 'Weightlifting', 47: 'Cross Country Skiing',
	48: 'Functional Fitness', 49: 'Duathlon', 51: 'Gymnastics', 52: 'Hiking/Rucking',
	53: 'Horseback Riding', 55: 'Kayaking', 56: 'Martial Arts', 57: 'Mountain Biking',
	59: 'Powerlifting', 60: 'Rock Climbing', 61: 'Paddleboarding', 62: 'Triathlon',
	63: 'Walking', 64: 'Surfing', 65: 'Elliptical', 66: 'Stairmaster', 70: 'Meditation',
	71: 'Other', 73: 'Diving', 74: 'Operations - Tactical', 75: 'Operations - Medical',
	76: 'Operations - Flying', 77: 'Operations - Water', 82: 'Ultimate', 83: 'Climber',
	84: 'Jumping Rope', 85: 'Australian Football', 86: 'Skateboarding', 87: 'Coaching',
	88: 'Ice Bath', 89: 'Commuting', 90: 'Gaming', 91: 'Snowboarding', 92: 'Motocross',
	93: 'Caddying', 94: 'Obstacle Course Racing', 95: 'Motor Racing', 96: 'HIIT',
	97: 'Spin', 98: 'Jiu Jitsu', 99: 'Manual Labor', 100: 'Cricket', 101: 'Pickleball',
	102: 'Inline Skating', 103: 'Box Fitness', 104: 'Spikeball', 105: 'Wheelchair Pushing',
	106: 'Paddle Tennis', 107: 'Barre', 108: 'Stage Performance', 109: 'High Stress Work',
	110: 'Parkour', 111: 'Gaelic Football', 112: 'Hurling/Camogie', 113: 'Circus Arts',
	121: 'Massage Therapy', 123: 'Strength Trainer', 125: 'Watching Sports', 126: 'Assault Bike',
	127: 'Kickboxing', 128: 'Stretching', 230: 'Table Tennis', 231: 'Badminton',
	232: 'Netball', 233: 'Sauna', 234: 'Disc Golf', 235: 'Yard Work', 236: 'Air Compression',
	237: 'Percussive Massage', 238: 'Paintball', 239: 'Ice Skating', 240: 'Handball',
};

function sportName(id: number): string {
	return SPORT_NAMES[id] ?? `Sport ${id}`;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function validateActivityDays(value: unknown): number {
	if (value === undefined || value === null) return 7;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 7;
	return Math.min(num, 30);
}

function kjToCal(kj: number | null): number | null {
	return kj == null ? null : Math.round(kj / 4.184);
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_activities',
				description: 'List individual workouts/activities with sport, duration, strain, HR, and calories.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to look back (default: 7, max: 30)' } },
					required: [],
				},
			},
			{
				name: 'get_activity_detail',
				description: 'Get full detail for a single workout including HR zone breakdown.',
				inputSchema: {
					type: 'object',
					properties: { workout_id: { type: 'string', description: 'The workout UUID' } },
					required: ['workout_id'],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_activities', 'get_activity_detail'];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch (err) {
					process.stderr.write(`[smartSync] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_activities': {
					const days = validateActivityDays(typedArgs.days);
					const end = new Date();
					const start = new Date();
					start.setDate(start.getDate() - days);
					const workouts = db.getWorkoutsByDateRange(start.toISOString(), end.toISOString());

					if (workouts.length === 0) {
						return { content: [{ type: 'text', text: `No activities found in the last ${days} days.` }] };
					}

					let response = `# Activities (Last ${days} Days)\n\n`;
					response += '| Date | Sport | Duration | Strain | Avg HR | Max HR | Calories |\n';
					response += '|------|-------|----------|--------|--------|--------|----------|\n';

					for (const w of workouts) {
						const duration = new Date(w.end_time).getTime() - new Date(w.start_time).getTime();
						const cal = kjToCal(w.kilojoule);
						response += `| ${formatDate(w.start_time)} | ${sportName(w.sport_id)} | ${formatDuration(duration)} | `;
						response += `${w.strain?.toFixed(1) ?? 'N/A'} | ${w.avg_hr ?? 'N/A'} | ${w.max_hr ?? 'N/A'} | ${cal ?? 'N/A'} |\n`;
					}

					response += `\n_${workouts.length} activities. Use get_activity_detail with a workout_id for HR zone breakdown._\n`;
					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_activity_detail': {
					const workoutId = typeof typedArgs.workout_id === 'string' ? typedArgs.workout_id : '';
					if (!workoutId) {
						return { content: [{ type: 'text', text: 'workout_id is required.' }] };
					}

					const w = db.getWorkoutById(workoutId);
					if (!w) {
						return { content: [{ type: 'text', text: `No workout found with id ${workoutId}. It may be outside the synced range — try sync_data with full=true.` }] };
					}

					const duration = new Date(w.end_time).getTime() - new Date(w.start_time).getTime();
					const cal = kjToCal(w.kilojoule);

					let response = `# ${sportName(w.sport_id)} — ${formatDate(w.start_time)}\n\n`;
					response += `- **Workout ID**: ${w.id}\n`;
					response += `- **Sport**: ${sportName(w.sport_id)} (id ${w.sport_id})\n`;
					response += `- **Start**: ${new Date(w.start_time).toLocaleString()}\n`;
					response += `- **End**: ${new Date(w.end_time).toLocaleString()}\n`;
					response += `- **Duration**: ${formatDuration(duration)}\n`;
					response += `- **Strain**: ${w.strain?.toFixed(1) ?? 'N/A'} ${w.strain != null ? `(${getStrainZone(w.strain)})` : ''}\n`;
					response += `- **Avg HR**: ${w.avg_hr ?? 'N/A'} bpm\n`;
					response += `- **Max HR**: ${w.max_hr ?? 'N/A'} bpm\n`;
					response += `- **Calories**: ${cal ?? 'N/A'} kcal\n`;
					response += `- **Score state**: ${w.score_state}\n`;

					const zones = [
						{ label: 'Zone 0 (Rest)', ms: w.zone_zero_milli },
						{ label: 'Zone 1 (50-60%)', ms: w.zone_one_milli },
						{ label: 'Zone 2 (60-70%)', ms: w.zone_two_milli },
						{ label: 'Zone 3 (70-80%)', ms: w.zone_three_milli },
						{ label: 'Zone 4 (80-90%)', ms: w.zone_four_milli },
						{ label: 'Zone 5 (90-100%)', ms: w.zone_five_milli },
					];
					const totalZoneMs = zones.reduce((sum, z) => sum + (z.ms ?? 0), 0);

					if (totalZoneMs > 0) {
						response += `\n## HR Zone Breakdown\n\n| Zone | Time | % |\n|------|------|---|\n`;
						for (const z of zones) {
							const ms = z.ms ?? 0;
							const pct = totalZoneMs > 0 ? ((ms / totalZoneMs) * 100).toFixed(1) : '0.0';
							response += `| ${z.label} | ${formatDuration(ms)} | ${pct}% |\n`;
						}
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use(express.json());

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(err => {
					process.stderr.write(`[postAuthSync] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
				});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			// CORS: Claude.ai's connector runs in a browser and sends a
			// preflight; it must also be able to read the session id header.
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');
			res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

			if (req.method === 'OPTIONS') {
				res.status(204).end();
				return;
			}

			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
				}

				await transport.handleRequest(req, res, req.body);
				return;
			}

			// GET opens the server-to-client SSE stream for an existing session.
			if (req.method === 'GET' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				session.lastAccess = Date.now();
				await session.transport.handleRequest(req, res);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
