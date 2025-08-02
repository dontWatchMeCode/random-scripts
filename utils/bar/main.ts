import { $ } from 'npm:zx';
import { parse as parseToml } from 'jsr:@std/toml';

let debug = false;
if (Deno.args.includes('--debug')) {
	debug = true;
}

// deno-lint-ignore no-explicit-any
const debugLog = (...args: any[]) => {
	if (debug) console.log('//', ...args);
};

const config_path = Deno.env.get('config_path');

interface Config {
	bar_time_until: string | null;
	bar_vps_ip: string | null;
}

const config: Config = { bar_time_until: null, bar_vps_ip: null };
if (config_path) {
	try {
		const text = await Deno.readTextFile(config_path);
		const parsedData = parseToml(text);

		try {
			// deno-lint-ignore no-explicit-any
			config.bar_time_until = String((parsedData.bar as Array<any>)[0].time_until) ?? null;
			// deno-lint-ignore no-empty
		} catch (_) {}

		try {
			// deno-lint-ignore no-explicit-any
			config.bar_vps_ip = String((parsedData.bar as Array<any>)[0].vps_ip) ?? null;
			// deno-lint-ignore no-empty
		} catch (_) {}
	} catch (error) {
		debugLog(`Error reading config file: ${error}`);
	}
}

const kv_path = Deno.env.get('kv_path');
if (!kv_path) {
	throw new Error('kv_path is not set');
}

const kv = await Deno.openKv(kv_path);

if (Deno.args.includes('--clear')) {
	for await (const entry of kv.list({ prefix: [] })) {
		debugLog(`Deleting ${entry.key}`);
		await kv.delete(entry.key);
	}

	console.log('Cleared cache');
	Deno.exit();
}

if (Deno.args.includes('--kv-path')) {
	console.log('kv_path: ' + kv_path);
	Deno.exit();
}

const fetchData = {
	runningDockerContainers: async () => {
		return (await $`echo -n "$(docker ps -q | wc -l)"`).stdout;
	},
	dnfUpdates: async () => {
		return (await $`echo -n "$(dnf check-update -q|grep -c ^[a-z0-9])"`).stdout;
	},
	wakatimeToday: async () => {
		return utils.convertTimeToHours(
			(await $`echo -n "$(~/.wakatime/wakatime-cli-linux-amd64 --today)"`)
				.stdout,
		);
	},
	getMeminfoDirty: async () => {
		return (
			await $`echo -n "$(cat /proc/meminfo | grep Dirty | awk '{print $2}')" | numfmt --to=iec `
		).stdout;
	},
	countRunningProcesses: async () => {
		return (await $`ps -e --no-headers | wc -l`).stdout;
	},
	countZombieProcesses: async () => {
		return (await $`ps aux | awk '{print $8}' | grep -c 'Z'`).stdout;
	},
};

const utils = {
	convertTimeToHours: (timeString: string) => {
		const hoursMatch = timeString.match(/(\d+)\s*hrs?/);
		const minutesMatch = timeString.match(/(\d+)\s*mins?/);

		const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
		const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;

		const totalHours = hours + minutes / 60;

		return totalHours.toFixed(2) + 'h';
	},
	calculateTimeUntilNextDayTarget: (targetTimeStr: string) => {
		// Validate time format (HH:MM)
		const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
		if (!timeRegex.test(targetTimeStr)) {
			debugLog(
				'Error: Invalid time format. Please use HH:MM (e.g., 09:30 or 14:00).',
			);
			return;
		}

		const [targetHour, targetMinute] = targetTimeStr.split(':').map(Number);

		const now = new Date();
		const currentHour = now.getHours();
		const currentMinute = now.getMinutes();

		const targetDate = new Date(); // Start with today's date

		// If the target time has already passed today, set target date to tomorrow
		if (
			targetHour < currentHour ||
			(targetHour === currentHour && targetMinute <= currentMinute)
		) {
			targetDate.setDate(now.getDate() + 1); // Move to tomorrow
		}

		// Set the target hour, minute, second, and millisecond on the target date
		targetDate.setHours(targetHour, targetMinute, 0, 0);

		// Calculate the difference in milliseconds
		const diffMilliseconds = targetDate.getTime() - now.getTime();

		// Handle cases where difference might be negative (shouldn't happen with logic above)
		if (diffMilliseconds < 0) {
			debugLog(
				'Error: Calculated time difference is negative. This indicates a logical issue.',
			);
			return;
		}

		// Convert milliseconds to hours, minutes, seconds
		const totalSeconds = Math.floor(diffMilliseconds / 1000);

		const hours = Math.floor(totalSeconds / 3600);
		const remainingSecondsAfterHours = totalSeconds % 3600;
		const minutes = Math.floor(remainingSecondsAfterHours / 60);

		return `${hours}h ${minutes}m`;
	},
};

const apis = {
	pingIpAddress: async (ipAddress: string) => {
		try {
			const responseData = (
				await $`ping -c 3 ${ipAddress} | awk '/packets transmitted/ {loss = $6; gsub(/%/, "", loss); success = 100 - loss; print success "%"} /avg/ {split($4, a, "/"); print a[2] "ms"}'`
			).stdout;

			return responseData.replaceAll('\n', ' ');
		} catch (error) {
			debugLog(`Error pinging ${ipAddress}: ${error}`);
		}

		return false;
	},
};

type FetchDataKey = keyof typeof fetchData;

const getCachedData = async (key: FetchDataKey, expireIn: number = 60) => {
	const cacheKey = ['bar', key];
	const cachedValue = await kv.get(cacheKey);

	if (cachedValue.value) {
		debugLog(`Cache hit for ${key} with value ${cachedValue.value}`);
		return String(cachedValue.value);
	}

	const newValue = await fetchData[key]();
	await kv.set(cacheKey, newValue, { expireIn: expireIn * 1000 });
	debugLog(
		`Cache miss for ${key} with value ${newValue} and expireIn ${expireIn} seconds`,
	);
	return newValue;
};

let line = `
/
  p:${await fetchData.countRunningProcesses()}
  #/
  z:${await fetchData.countZombieProcesses()}
  #/
  d:${await fetchData.getMeminfoDirty()}
  #/
  u:${await getCachedData('dnfUpdates', 300)}
`;

if (config.bar_vps_ip) {
	const vpsStatus = await apis.pingIpAddress(config.bar_vps_ip);
	if (vpsStatus) {
		line += `
        #-#
        vps:#${vpsStatus.replaceAll(' ', '#')}
        `;
	}
}

if (config.bar_time_until) {
	const timeUntil = utils.calculateTimeUntilNextDayTarget(
		config.bar_time_until,
	);

	if (timeUntil) {
		line += `
        #-#
        t:#${timeUntil.replaceAll(' ', '#')}
        `;
	}
}

console.log(line.replaceAll('\n', '').replaceAll(' ', '').replaceAll('#', ' '));

const memUsage = Deno.memoryUsage();
const rssMB = memUsage.rss / (1024 * 1024);
debugLog(`Total memory (RSS): ${rssMB.toFixed(2)} MB`);
