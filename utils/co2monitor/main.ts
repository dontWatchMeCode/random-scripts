import Co2Monitor from 'npm:co2-monitor';

const co2Monitor = new Co2Monitor();

import { InfluxDB, Point } from 'npm:@influxdata/influxdb-client';

const token = Deno.env.get('influxdb_token');
if (!token) throw new Error('influxdb_token is not set');

const url = Deno.env.get('influxdb_url');
if (!url) throw new Error('INFLUXDB_URL is not set');

const client = new InfluxDB({ url, token });

const org = Deno.env.get('influxdb_org');
if (!org) throw new Error('influxdb_org is not set');

const bucket = Deno.env.get('influxdb_bucket');
if (!bucket) throw new Error('influxdb_bucket is not set');

const writeClient = client.getWriteApi(org, bucket, 'ns');

const writeLog = (message: string) => {
	console.log(message);

	const path = String(Deno.env.get('log_path')).trim();
	if (!path) return;

	Deno.truncateSync(path, 256);

	const timestamp = new Date().toISOString();

	Deno.writeFileSync(path, new TextEncoder().encode(timestamp + ' ' + message + '\n'), { append: true });
};
if (Deno.args.includes('--logs')) {
	const logPath = String(Deno.env.get('log_path')).trim();
	if (!logPath) {
		console.error('log_path is not set');
		Deno.exit(1);
	}

	const log = await Deno.readTextFile(logPath);
	const lines = log.split('\n');
	lines.reverse();
	console.log(lines.slice(0, 20).join('\n'));

	Deno.exit(0);
}

// ... (rest of the code)

co2Monitor.on('connected', () => {
	writeLog('Co2Monitor connected');
});

co2Monitor.on('disconnected', () => {
	writeLog('Co2Monitor disconnected');
});

co2Monitor.on('error', (error: Error) => {
	console.error(error);

	setTimeout(() => {
		Deno.exit(1);
	}, 10000);

	co2Monitor.disconnect(() => {
		Deno.exit(1);
	});
});

co2Monitor.on('co2', (co2: Co2Response) => {
	writeLog('co2: ' + co2.toString());

	const point = new Point('measurement')
		.intField('co2_val', co2.value);

	writeClient.writePoint(point);
	writeClient.flush();
});

co2Monitor.on('temperature', (temperature: TemperatureResponse) => {
	writeLog('temperature: ' + temperature.toString());

	const point = new Point('measurement')
		.floatField('temperature_val', temperature.value);

	writeClient.writePoint(point);
	writeClient.flush();
});

/* co2Monitor.on('humidity', (humidity) => {
	console.log('humidity: ' + humidity.toString());
	Deno.writeFileSync('./logs/humidity.jsonl', new TextEncoder().encode(humidity.toString() + '\n'), { append: true });
}); */

/* co2Monitor.on('data', (data) => {
	console.log('data: ' + data.toString());
	Deno.writeFileSync('./logs/data.jsonl', new TextEncoder().encode(data.toString() + '\n'), { append: true });
}); */

co2Monitor.connect((error: Error) => {
	if (error) {
		console.error(error);
		Deno.exit(1);
	}

	co2Monitor.startTransfer((error: Error) => {
		if (!error) return;
		console.error(error);
		Deno.exit(1);
	});
});

interface TemperatureResponse {
	value: number;
	type: 'float';
	unit: 'degree celsius';
	symbol: '°C';
}

interface HumidityResponse {
	value: number;
	type: 'float';
	unit: 'relative humidity';
	symbol: '% rh';
}

interface Co2Response {
	value: number;
	type: 'int';
	unit: 'parts per million';
	symbol: 'ppm';
}
