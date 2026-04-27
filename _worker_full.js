export default {
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/resolve') {
			const proxyip = url.searchParams.get('proxyip');
			if (!proxyip) {
				return new Response('Missing proxyip', { status: 400 });
			}

			try {
				const targets = await handleResolve(proxyip);
				return new Response(JSON.stringify(targets), {
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: error.message }), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}
		} else if (url.pathname === '/locations') return fetch(new Request('https://speed.cloudflare.com/locations', { headers: { 'Referer': 'https://speed.cloudflare.com/' } }));
		return new Response(generateHTML(), {
			headers: { 'Content-Type': 'text/html; charset=UTF-8' }
		});
	}
};

async function handleResolve(input) {
	let { host, port } = parseTarget(input);

	const tpPortMatch = host.toLowerCase().match(/\.tp(\d{1,5})\./);
	if (tpPortMatch) {
		const tpPort = Number(tpPortMatch[1]);
		if (tpPort >= 1 && tpPort <= 65535) {
			port = tpPort;
		}
	}

	const bracketedIPv6 = host.startsWith('[') && host.endsWith(']');
	const rawIPv6 = /^[0-9a-fA-F:]+$/.test(host);
	if (isIPv4(host) || bracketedIPv6 || rawIPv6) {
		const finalHost = rawIPv6 && !bracketedIPv6 ? `[${host}]` : host;
		return [`${finalHost}:${port}`];
	}

	if (host.toLowerCase().includes('.william.')) {
		const txtRecords = await dohQuery(host, 'TXT');
		if (txtRecords.length) {
			const targets = [];
			for (const record of txtRecords) {
				const value = normalizeTxtValue(record.data);
				for (const part of value.split(',')) {
					const candidate = part.trim();
					if (candidate) targets.push(candidate);
				}
			}
			if (targets.length) {
				return targets;
			}
		}
	}

	const [aRecords, aaaaRecords] = await Promise.all([
		dohQuery(host, 'A'),
		dohQuery(host, 'AAAA')
	]);

	const results = [];
	for (const record of aRecords.filter(item => item.type === 1 && item.data)) {
		results.push(`${record.data}:${port}`);
	}
	for (const record of aaaaRecords.filter(item => item.type === 28 && item.data)) {
		results.push(`[${record.data}]:${port}`);
	}

	if (!results.length) {
		throw new Error('Could not resolve domain');
	}

	return results;
}

function parseTarget(input) {
	let host = String(input || '').split('#')[0].trim();
	let port = 443;

	if (host.startsWith('[')) {
		const ipv6PortIndex = host.lastIndexOf(']:');
		if (ipv6PortIndex !== -1) {
			const maybePort = Number(host.slice(ipv6PortIndex + 2));
			if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
				port = maybePort;
				host = host.slice(0, ipv6PortIndex + 1);
			}
		}
		return { host, port };
	}

	const colonMatches = host.match(/:/g) || [];
	if (colonMatches.length === 1) {
		const separatorIndex = host.lastIndexOf(':');
		const maybePort = Number(host.slice(separatorIndex + 1));
		if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
			port = maybePort;
			host = host.slice(0, separatorIndex);
		}
	}

	return { host, port };
}

function isIPv4(value) {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => {
		if (!/^\d{1,3}$/.test(part)) return false;
		const num = Number(part);
		return num >= 0 && num <= 255;
	});
}

function normalizeTxtValue(value) {
	const text = String(value ?? '').trim();
	if (text.startsWith('"') && text.endsWith('"')) {
		return text.slice(1, -1).replace(/\\"/g, '"');
	}
	return text.replace(/\\"/g, '"');
}

async function dohQuery(name, type, endpoint = 'https://cloudflare-dns.com/dns-query') {
	const startedAt = performance.now();

	try {
		const response = await fetch(
			`${endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
			{
				headers: {
					accept: 'application/dns-json'
				}
			}
		);

		if (!response.ok) {
			console.warn(`[DoH] ${name} ${type} failed with status ${response.status}`);
			return [];
		}

		const payload = await response.json();
		if (!Array.isArray(payload.Answer)) {
			console.log(`[DoH] ${name} ${type} returned 0 answers in ${(performance.now() - startedAt).toFixed(2)}ms`);
			return [];
		}

		const answers = payload.Answer.map(answer => ({
			name: answer.name || name,
			type: answer.type,
			TTL: answer.TTL,
			data: answer.type === 16 ? normalizeTxtValue(answer.data) : answer.data
		}));

		console.log(`[DoH] ${name} ${type} returned ${answers.length} answers in ${(performance.now() - startedAt).toFixed(2)}ms`);
		return answers;
	} catch (error) {
		console.error(`[DoH] ${name} ${type} error after ${(performance.now() - startedAt).toFixed(2)}ms`, error);
		return [];
	}
}

function generateHTML() {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="color-scheme" content="light dark">
	<title>Check ProxyIP</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
	<script>
		(function () {
			const storageKey = 'cf_proxy_theme';
			let theme = 'dark';
			try {
				const storedTheme = localStorage.getItem(storageKey);
				if (storedTheme === 'light' || storedTheme === 'dark') {
					theme = storedTheme;
				} else {
					theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
				}
			} catch (error) {
				theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
			}
			document.documentElement.dataset.theme = theme;
			document.documentElement.style.colorScheme = theme;
		})();
	</script>
	<style>
		:root {
			--bg-base: #07111d;
			--bg-deep: #0b1726;
			--panel: rgba(10, 24, 40, 0.78);
			--panel-strong: rgba(15, 31, 49, 0.92);
			--line: rgba(144, 180, 212, 0.18);
			--text: #edf7ff;
			--text-soft: #d4e4f3;
			--muted: #8ea6bc;
			--accent: #61dbff;
			--accent-strong: #2dd4bf;
			--accent-warm: #ffb869;
			--success: #34d399;
			--error: #fb7185;
			--warning: #fbbf24;
			--shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
			--shadow-soft: 0 16px 44px rgba(0, 0, 0, 0.26);
			--radius-xl: 30px;
			--radius-lg: 24px;
			--radius-md: 20px;
		}

		html {
			color-scheme: dark;
		}

		html[data-theme='light'] {
			color-scheme: light;
			--bg-base: #eef6fb;
			--bg-deep: #ffffff;
			--panel: rgba(255, 255, 255, 0.72);
			--panel-strong: rgba(255, 255, 255, 0.92);
			--line: rgba(95, 123, 150, 0.18);
			--text: #10253d;
			--text-soft: #23415a;
			--muted: #61778f;
			--accent: #0ea5e9;
			--accent-strong: #14b8a6;
			--accent-warm: #f59e0b;
			--success: #059669;
			--error: #e11d48;
			--warning: #d97706;
			--shadow: 0 24px 64px rgba(43, 67, 91, 0.14);
			--shadow-soft: 0 16px 34px rgba(43, 67, 91, 0.1);
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			margin: 0;
			min-height: 100%;
		}

		body {
			font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
			color: var(--text);
			background:
				radial-gradient(circle at top left, rgba(45, 212, 191, 0.18), transparent 28%),
				radial-gradient(circle at 85% 12%, rgba(97, 219, 255, 0.18), transparent 24%),
				radial-gradient(circle at 50% 110%, rgba(255, 184, 105, 0.16), transparent 30%),
				linear-gradient(180deg, #06101b 0%, #081321 38%, #0a1624 100%);
			overflow-x: hidden;
			transition: background 0.28s ease, color 0.28s ease;
		}

		body::before {
			content: '';
			position: fixed;
			inset: 0;
			pointer-events: none;
			background-image:
				linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
				linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
			background-size: 46px 46px;
			mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.38), transparent 92%);
			opacity: 0.12;
		}

		html[data-theme='light'] body {
			background:
				radial-gradient(circle at top left, rgba(20, 184, 166, 0.16), transparent 30%),
				radial-gradient(circle at 88% 12%, rgba(14, 165, 233, 0.14), transparent 24%),
				radial-gradient(circle at 50% 110%, rgba(245, 158, 11, 0.12), transparent 28%),
				linear-gradient(180deg, #f6fbff 0%, #eef5fb 44%, #e8f1f7 100%);
		}

		html[data-theme='light'] body::before {
			background-image:
				linear-gradient(rgba(16, 37, 61, 0.05) 1px, transparent 1px),
				linear-gradient(90deg, rgba(16, 37, 61, 0.05) 1px, transparent 1px);
			mask-image: linear-gradient(180deg, rgba(255, 255, 255, 0.68), transparent 92%);
			opacity: 0.28;
		}

		button,
		input,
		textarea {
			font: inherit;
		}

		body,
		.surface-card,
		.input-control,
		.history-toggle,
		.history-dropdown,
		.mode-card,
		.progress-container,
		.metric-card,
		.results-pill,
		.results-empty,
		.empty-visual,
		.guide-card,
		.guide-flow,
		.guide-step,
		.guide-tip,
		.result-item,
		.status-badge,
		.meta-chip,
		.exit-ip-btn,
		.map-container-wrapper,
		.theme-toggle {
			transition: background 0.28s ease, border-color 0.28s ease, color 0.28s ease, box-shadow 0.28s ease, opacity 0.28s ease;
		}

		.page-shell {
			position: relative;
			min-height: 100vh;
			padding: 12px 24px 40px;
		}

		.ambient {
			position: fixed;
			border-radius: 999px;
			filter: blur(80px);
			pointer-events: none;
			z-index: 0;
			opacity: 0.28;
		}

		.ambient-one {
			width: 34rem;
			height: 34rem;
			left: -9rem;
			top: 10rem;
			background: rgba(97, 219, 255, 0.22);
		}

		.ambient-two {
			width: 28rem;
			height: 28rem;
			right: -6rem;
			top: -3rem;
			background: rgba(45, 212, 191, 0.18);
		}

		html[data-theme='light'] .ambient-one {
			background: rgba(56, 189, 248, 0.2);
		}

		html[data-theme='light'] .ambient-two {
			background: rgba(45, 212, 191, 0.16);
		}

		.site-header,
		.site-main,
		.site-footer {
			position: relative;
			z-index: 1;
			max-width: 1200px;
			margin: 0 auto;
		}

		.site-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 24px;
			margin-bottom: 24px;
		}

		.brand {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.brand-chip {
			display: none;
		}

		.header-note {
			display: none;
		}

		.theme-toggle {
			position: fixed;
			top: 12px;
			right: 12px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			border: none;
			border-radius: 0;
			background: transparent;
			color: var(--text);
			box-shadow: none;
			backdrop-filter: none;
			cursor: pointer;
			min-width: 0;
			transition: color 0.28s ease;
			z-index: 9999;
		}

		.theme-toggle:hover {
			transform: none;
		}

		.theme-toggle:focus-visible {
			outline: none;
		}

		.theme-toggle-switch {
			position: relative;
			width: 56px;
			height: 30px;
			flex: none;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.18), rgba(45, 212, 191, 0.12));
			box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
			transition: transform 0.2s ease, background 0.28s ease, border-color 0.28s ease, box-shadow 0.28s ease;
		}

		.theme-toggle:hover .theme-toggle-switch {
			transform: translateY(-1px);
			border-color: rgba(97, 219, 255, 0.2);
			box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
		}

		.theme-toggle:focus-visible .theme-toggle-switch {
			box-shadow: 0 0 0 4px rgba(97, 219, 255, 0.12), 0 10px 24px rgba(0, 0, 0, 0.18);
		}

		.theme-toggle-icon {
			position: absolute;
			top: 9px;
			width: 12px;
			height: 12px;
			color: rgba(255, 255, 255, 0.72);
			pointer-events: none;
		}

		.theme-toggle-icon-light {
			left: 8px;
			color: #ffd97d;
		}

		.theme-toggle-icon-dark {
			right: 8px;
			color: #d9efff;
		}

		.theme-toggle-thumb {
			position: absolute;
			top: 3px;
			left: 3px;
			width: 22px;
			height: 22px;
			border-radius: 50%;
			background: linear-gradient(135deg, #ffffff, #d9e9f7);
			box-shadow: 0 6px 14px rgba(0, 0, 0, 0.24);
			transform: translateX(28px);
			transition: transform 0.28s ease, background 0.28s ease, box-shadow 0.28s ease;
		}

		html[data-theme='light'] .theme-toggle-thumb {
			transform: translateX(0);
			background: linear-gradient(135deg, #fff9d9, #ffd88a);
			box-shadow: 0 8px 16px rgba(168, 116, 23, 0.18);
		}

		html[data-theme='light'] .theme-toggle-switch {
			border-color: rgba(84, 112, 139, 0.14);
			background: linear-gradient(135deg, rgba(254, 240, 138, 0.56), rgba(125, 211, 252, 0.34));
		}

		html[data-theme='light'] .theme-toggle-icon {
			color: #53708d;
		}

		html[data-theme='light'] .theme-toggle-icon-light {
			color: #d97706;
		}

		html[data-theme='light'] .theme-toggle-icon-dark {
			color: #2563eb;
		}

		.surface-card {
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 36%),
				var(--panel);
			border: 1px solid var(--line);
			border-radius: var(--radius-xl);
			box-shadow: var(--shadow);
			backdrop-filter: blur(18px);
		}

		.section-kicker {
			display: none;
		}

		.section-kicker::before {
			content: '';
			width: 26px;
			height: 1px;
			background: linear-gradient(90deg, transparent, rgba(97, 219, 255, 0.85));
		}

		.panel-copy,
		.field-hint,
		.summary-description,
		.results-subtitle,
		.empty-copy p,
		.site-footer {
			color: var(--muted);
			line-height: 1.8;
		}

		.summary-description,
		.empty-copy p {
			margin: 0;
		}

		.workspace-grid {
			display: grid;
			grid-template-columns: minmax(0, 2.2fr) minmax(300px, 0.7fr);
			gap: 24px;
			align-items: stretch;
			margin-top: 0;
			position: relative;
			z-index: 4;
		}

		.control-panel {
			padding: 16px 30px 30px;
			display: flex;
			flex-direction: column;
			min-height: 100%;
			position: relative;
			z-index: 5;
		}

		.panel-header,
		.results-header {
			display: flex;
			justify-content: flex-start;
			align-items: baseline;
			gap: 20px;
		}

		.panel-title,
		.summary-title,
		.results-title,
		.empty-copy h3 {
			margin: 0;
			font-size: 1.45rem;
			font-weight: 700;
			letter-spacing: -0.02em;
		}

		.panel-copy {
			margin: 10px 0 0;
			max-width: 58ch;
		}

		.panel-badge {
			display: none;
		}

		.input-zone {
			margin-top: 8px;
		}

		.field-label {
			display: block;
			margin-bottom: 12px;
			font-size: 0.9rem;
			font-weight: 600;
			color: #d9efff;
		}

		.input-wrapper {
			position: relative;
			flex: 1;
			display: flex;
			flex-direction: column;
		}

		.input-control {
			width: 100%;
			padding: 18px 64px 18px 20px;
			border: 1px solid var(--line);
			border-radius: 22px;
			background: rgba(4, 14, 24, 0.52);
			color: var(--text);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
			transition: border-color 0.24s ease, box-shadow 0.24s ease, background 0.24s ease;
		}

		.input-control::placeholder {
			color: #7390a9;
		}

		.input-control:focus {
			outline: none;
			background: rgba(5, 18, 29, 0.74);
			border-color: rgba(97, 219, 255, 0.34);
			box-shadow: 0 0 0 4px rgba(97, 219, 255, 0.08);
		}

		textarea.input-control {
			flex: 1;
			height: 100%;
			min-height: 200px;
			resize: none;
			padding: 20px;
			padding-right: 20px;
			line-height: 1.75;
		}

		.field-hint {
			margin: 12px 0 0;
			font-size: 0.9rem;
		}

		.history-toggle {
			position: absolute;
			right: 16px;
			top: 14px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 38px;
			height: 38px;
			border-radius: 14px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(255, 255, 255, 0.03);
			color: #b1c7db;
			cursor: pointer;
			transition: background 0.2s ease, color 0.2s ease;
		}

		.history-toggle:hover {
			color: #f7fbff;
			background: rgba(97, 219, 255, 0.08);
			transform: translateY(calc(-50% - 1px));
		}

		.history-dropdown {
			position: absolute;
			top: calc(100% + 10px);
			left: 0;
			right: 0;
			display: none;
			padding: 8px;
			border-radius: 20px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(8, 19, 32, 0.96);
			box-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
			max-height: 280px;
			overflow-y: auto;
			z-index: 80;
		}

		.history-item {
			width: 100%;
			padding: 13px 14px;
			border: none;
			background: transparent;
			border-radius: 14px;
			color: var(--text-soft);
			text-align: left;
			cursor: pointer;
			transition: background 0.2s ease, color 0.2s ease;
		}

		.history-item:hover {
			background: rgba(97, 219, 255, 0.08);
			color: #ffffff;
		}

		.history-item.is-empty {
			color: #69839a;
			cursor: default;
		}

		.control-row {
			display: flex;
			gap: 16px;
			align-items: stretch;
			margin-top: 18px;
		}

		.mode-card {
			min-width: 238px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			padding: 18px 18px 18px 20px;
			border-radius: 22px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.07);
		}

		.mode-copy strong {
			display: block;
			margin-bottom: 6px;
			font-size: 0.98rem;
		}

		.mode-state {
			font-size: 0.88rem;
			color: var(--muted);
		}

		.switch {
			position: relative;
			display: inline-block;
			width: 54px;
			height: 30px;
			flex: none;
		}

		.switch input {
			opacity: 0;
			width: 0;
			height: 0;
		}

		.slider {
			position: absolute;
			inset: 0;
			cursor: pointer;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.12);
			border: 1px solid rgba(255, 255, 255, 0.08);
			transition: 0.28s ease;
		}

		.slider::before {
			content: '';
			position: absolute;
			width: 22px;
			height: 22px;
			left: 3px;
			top: 3px;
			border-radius: 50%;
			background: #ffffff;
			box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
			transition: 0.28s ease;
		}

		.switch input:checked + .slider {
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.92), rgba(45, 212, 191, 0.84));
			border-color: transparent;
		}

		.switch input:checked + .slider::before {
			transform: translateX(24px);
		}

		.primary-btn {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 4px;
			border: none;
			padding: 16px 20px;
			border-radius: 22px;
			background: linear-gradient(135deg, var(--accent), #8cf2ff 52%, var(--accent-warm));
			color: #052538;
			font-weight: 800;
			cursor: pointer;
			box-shadow: 0 18px 34px rgba(97, 219, 255, 0.28);
			transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
		}

		.primary-btn small {
			color: rgba(5, 37, 56, 0.78);
			font-size: 0.8rem;
			font-weight: 700;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.primary-btn:hover {
			transform: translateY(-2px);
			box-shadow: 0 24px 42px rgba(97, 219, 255, 0.34);
		}

		.primary-btn:disabled {
			cursor: wait;
			transform: none;
			opacity: 0.74;
			box-shadow: 0 14px 26px rgba(97, 219, 255, 0.18);
		}

		.progress-container {
			display: grid;
			gap: 10px;
			margin-top: 18px;
			padding: 16px;
			border-radius: 22px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.015)),
				rgba(255, 255, 255, 0.03);
		}

		.progress-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
			font-size: 0.92rem;
			color: var(--text-soft);
		}

		.progress-track {
			position: relative;
			height: 12px;
			border-radius: 999px;
			overflow: hidden;
			background: rgba(255, 255, 255, 0.08);
		}

		.progress-bar {
			width: 0%;
			height: 100%;
			border-radius: inherit;
			background: linear-gradient(90deg, var(--accent), var(--accent-strong), var(--accent-warm));
			transition: width 0.32s ease;
		}

		.side-column {
			display: grid;
			gap: 24px;
			min-height: 100%;
		}

		.side-card {
			padding: 26px;
			min-height: 100%;
		}

		.summary-description {
			margin-top: 10px;
		}

		.summary-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
			margin-top: 14px;
		}

		.metric-card {
			padding: 16px;
			border-radius: 18px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.06);
		}

		.metric-card span {
			display: block;
			margin-bottom: 6px;
			font-size: 0.82rem;
			color: var(--muted);
		}

		.metric-card strong {
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			font-size: 1.65rem;
			letter-spacing: -0.04em;
		}

		.results-shell {
			margin-top: 24px;
			padding: 28px;
			position: relative;
			z-index: 1;
		}

		.results-subtitle {
			margin: 10px 0 0;
		}

		.results-pill {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 10px 14px;
			border-radius: 999px;
			font-size: 0.82rem;
			font-weight: 700;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.04);
			color: #e8f5ff;
			white-space: nowrap;
		}

		.results-pill.state-idle {
			color: #d5e6f6;
		}

		.results-pill.state-resolving {
			background: rgba(251, 191, 36, 0.12);
			border-color: rgba(251, 191, 36, 0.22);
			color: #ffd97d;
		}

		.results-pill.state-running {
			background: rgba(97, 219, 255, 0.12);
			border-color: rgba(97, 219, 255, 0.24);
			color: #bff4ff;
		}

		.results-pill.state-done {
			background: rgba(52, 211, 153, 0.12);
			border-color: rgba(52, 211, 153, 0.24);
			color: #abffd8;
		}

		.results-pill.state-empty,
		.results-pill.state-error {
			background: rgba(251, 113, 133, 0.1);
			border-color: rgba(251, 113, 133, 0.22);
			color: #ffc4d0;
		}

		.results-empty {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 18px;
			align-items: center;
			padding: 24px;
			margin-top: 22px;
			margin-bottom: 18px;
			border-radius: 24px;
			border: 1px dashed rgba(144, 180, 212, 0.22);
			background: rgba(255, 255, 255, 0.025);
		}

		.empty-visual {
			position: relative;
			width: 90px;
			height: 90px;
			border-radius: 26px;
			background:
				radial-gradient(circle at 30% 30%, rgba(97, 219, 255, 0.26), transparent 42%),
				linear-gradient(160deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015));
			border: 1px solid rgba(255, 255, 255, 0.06);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
		}

		.empty-visual span {
			position: absolute;
			border-radius: 999px;
		}

		.empty-visual span:nth-child(1) {
			width: 44px;
			height: 44px;
			left: 10px;
			top: 14px;
			background: rgba(97, 219, 255, 0.24);
		}

		.empty-visual span:nth-child(2) {
			width: 18px;
			height: 18px;
			right: 18px;
			top: 18px;
			background: rgba(45, 212, 191, 0.48);
		}

		.empty-visual span:nth-child(3) {
			width: 56px;
			height: 10px;
			left: 18px;
			bottom: 18px;
			background: rgba(255, 255, 255, 0.12);
		}

		.results-list {
			display: grid;
			gap: 16px;
		}

		.results-controls {
			display: flex;
			flex-wrap: wrap;
			justify-content: space-between;
			align-items: center;
			gap: 16px;
			margin-top: 20px;
			padding: 12px 16px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.06);
			border-radius: 18px;
		}

		.control-group {
			display: flex;
			align-items: center;
			gap: 10px;
		}

		.control-btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 8px 14px;
			border-radius: 12px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.05);
			color: var(--text-soft);
			font-size: 0.82rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s ease;
		}

		.control-btn:hover {
			background: rgba(255, 255, 255, 0.1);
			border-color: rgba(97, 219, 255, 0.3);
			color: #ffffff;
		}

		.control-btn svg {
			width: 14px;
			height: 14px;
		}

		.filter-group {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.filter-label {
			font-size: 0.78rem;
			color: var(--muted);
			margin-right: 4px;
		}

		.filter-pill {
			padding: 6px 12px;
			border-radius: 10px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(255, 255, 255, 0.03);
			color: var(--muted);
			font-size: 0.76rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s ease;
		}

		.filter-pill:hover, .filter-pill.active {
			background: rgba(97, 219, 255, 0.1);
			border-color: rgba(97, 219, 255, 0.3);
			color: #bff4ff;
		}

		/* 内置反代域名选择器 */
		.input-zone-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 12px;
		}
		
		.input-zone-header .field-label {
			margin-bottom: 0;
			font-size: 1.35rem;
			font-weight: 700;
		}

		.clear-btn {
			margin-left: 10px;
			padding: 3px 8px;
			border-radius: 8px;
			border: 1px solid rgba(251, 113, 133, 0.25);
			background: rgba(251, 113, 133, 0.08);
			color: #fb7185;
			font-size: 0.72rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s ease;
			opacity: 0;
			visibility: hidden;
			transform: translateY(1px);
		}

		.input-zone:hover .clear-btn,
		.input-control:focus + .clear-btn,
		.clear-btn:hover {
			opacity: 0.9;
			visibility: visible;
			transform: translateY(0);
		}

		.clear-btn:hover {
			opacity: 1;
			background: rgba(251, 113, 133, 0.15);
			border-color: rgba(251, 113, 133, 0.45);
		}

		.preset-toggle-btn {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 9px 16px;
			border-radius: 14px;
			border: 1px solid rgba(97, 219, 255, 0.18);
			background: rgba(97, 219, 255, 0.06);
			color: #bff4ff;
			font-size: 0.88rem;
			font-weight: 600;
			cursor: pointer;
			transition: background 0.2s ease, border-color 0.2s ease;
		}

		.preset-toggle-btn:hover {
			background: rgba(97, 219, 255, 0.12);
			border-color: rgba(97, 219, 255, 0.32);
		}

		.preset-chevron {
			transition: transform 0.24s ease;
		}

		.input-body.is-open .preset-chevron {
			transform: rotate(180deg);
		}

		.input-body {
			display: flex;
			gap: 24px;
			align-items: stretch;
		}

		.input-col {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
		}

		.preset-col {
			display: none;
			flex: 1;
			min-width: 0;
			align-self: stretch;
		}

		.input-body.is-open .preset-col {
			display: block;
			animation: slideInRight 0.3s ease forwards;
		}

		@keyframes slideInRight {
			from { opacity: 0; transform: translateX(20px); }
			to { opacity: 1; transform: translateX(0); }
		}

		.preset-dropdown {
			height: 100%;
			padding: 18px;
			border-radius: 20px;
			border: 1px solid rgba(97, 219, 255, 0.14);
			background: rgba(6, 18, 30, 0.92);
			backdrop-filter: blur(16px);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
			display: flex;
			flex-direction: column;
		}

		.preset-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding-bottom: 12px;
			margin-bottom: 10px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.07);
		}

		.preset-check-all {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			color: var(--text-soft);
			font-size: 0.88rem;
			font-weight: 600;
			cursor: pointer;
			user-select: none;
		}

		.preset-check-all input[type="checkbox"] {
			appearance: none;
			width: 18px;
			height: 18px;
			border: 2px solid rgba(97, 219, 255, 0.3);
			border-radius: 5px;
			background: transparent;
			cursor: pointer;
			position: relative;
			transition: all 0.2s ease;
		}

		.preset-check-all input[type="checkbox"]:checked {
			background: var(--accent);
			border-color: var(--accent);
		}

		.preset-check-all input[type="checkbox"]:checked::after {
			content: '✓';
			position: absolute;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			color: #052538;
			font-size: 11px;
			font-weight: 900;
		}

		.preset-apply-btn {
			padding: 8px 16px;
			border-radius: 12px;
			border: none;
			background: linear-gradient(135deg, var(--accent), var(--accent-strong));
			color: #052538;
			font-size: 0.84rem;
			font-weight: 700;
			cursor: pointer;
			transition: opacity 0.2s ease, transform 0.2s ease;
		}

		.preset-apply-btn:hover {
			opacity: 0.88;
			transform: translateY(-1px);
		}

		.preset-list {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 6px;
			max-height: 265px;
			overflow-y: auto;
			padding-right: 4px;
		}

		.preset-list::-webkit-scrollbar {
			width: 6px;
		}
		
		.preset-list::-webkit-scrollbar-track {
			background: rgba(255, 255, 255, 0.02);
			border-radius: 4px;
		}
		
		.preset-list::-webkit-scrollbar-thumb {
			background: rgba(97, 219, 255, 0.15);
			border-radius: 4px;
		}

		.preset-item {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 10px 12px;
			border-radius: 12px;
			background: transparent;
			transition: background 0.18s ease;
			cursor: pointer;
			user-select: none;
		}

		.preset-item:hover {
			background: rgba(97, 219, 255, 0.07);
		}

		.preset-item input[type="checkbox"] {
			appearance: none;
			width: 16px;
			height: 16px;
			border: 2px solid rgba(97, 219, 255, 0.28);
			border-radius: 4px;
			background: transparent;
			cursor: pointer;
			flex: none;
			position: relative;
			transition: all 0.2s ease;
		}

		.preset-item input[type="checkbox"]:checked {
			background: var(--accent);
			border-color: var(--accent);
		}

		.preset-item input[type="checkbox"]:checked::after {
			content: '✓';
			position: absolute;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			color: #052538;
			font-size: 10px;
			font-weight: 900;
		}

		.preset-item-label {
			font-family: 'Space Grotesk', monospace;
			font-size: 0.9rem;
			color: var(--text-soft);
		}

		.guide-shell {
			margin-top: 24px;
			padding: 28px;
			position: relative;
			overflow: hidden;
			z-index: 1;
		}

		.guide-shell::before {
			content: '';
			position: absolute;
			inset: 0;
			background:
				radial-gradient(circle at top right, rgba(97, 219, 255, 0.14), transparent 30%),
				radial-gradient(circle at bottom left, rgba(45, 212, 191, 0.12), transparent 28%);
			pointer-events: none;
		}

		.guide-header,
		.guide-grid,
		.guide-flow,
		.guide-tip {
			position: relative;
			z-index: 1;
		}

		.guide-header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 20px;
		}

		.guide-badge {
			display: inline-flex;
			align-items: center;
			align-self: flex-start;
			padding: 10px 14px;
			border-radius: 999px;
			background: rgba(97, 219, 255, 0.08);
			border: 1px solid rgba(97, 219, 255, 0.16);
			color: #c6f5ff;
			font-size: 0.82rem;
			font-weight: 600;
			white-space: nowrap;
		}

		.guide-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 16px;
			margin-top: 24px;
		}

		.guide-grid-secondary {
			margin-top: 18px;
		}

		.guide-card {
			padding: 24px;
			border-radius: 26px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 44%),
				rgba(8, 20, 34, 0.6);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
		}

		.guide-card-accent {
			background:
				radial-gradient(circle at top left, rgba(97, 219, 255, 0.16), transparent 38%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 46%),
				rgba(9, 22, 37, 0.68);
		}

		.guide-card-warm {
			background:
				radial-gradient(circle at top right, rgba(255, 184, 105, 0.16), transparent 34%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 46%),
				rgba(14, 23, 35, 0.72);
		}

		.guide-card-label {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 14px;
			font-size: 0.74rem;
			font-weight: 700;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: #9feaff;
		}

		.guide-card-label::before {
			content: '';
			width: 18px;
			height: 1px;
			background: rgba(97, 219, 255, 0.72);
		}

		.guide-card h3 {
			margin: 0;
			font-size: 1.18rem;
			line-height: 1.4;
			letter-spacing: -0.02em;
		}

		.guide-card p {
			margin: 14px 0 0;
			color: var(--muted);
			line-height: 1.8;
		}

		.guide-card a {
			color: #bff4ff;
			text-decoration: none;
			border-bottom: 1px solid rgba(191, 244, 255, 0.26);
		}

		.guide-card a:hover {
			color: #ffffff;
			border-bottom-color: rgba(255, 255, 255, 0.42);
		}

		.guide-quote {
			margin-top: 16px;
			padding: 14px 16px;
			border-radius: 20px;
			border: 1px solid rgba(251, 191, 36, 0.18);
			background: rgba(251, 191, 36, 0.1);
			color: #ffe7a7;
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			line-height: 1.6;
		}

		.guide-flow {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
			gap: 14px;
			align-items: center;
			margin-top: 18px;
			padding: 24px;
			border-radius: 28px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 60%),
				rgba(255, 255, 255, 0.03);
		}

		.guide-step {
			padding: 18px 16px;
			border-radius: 22px;
			text-align: center;
			border: 1px solid rgba(255, 255, 255, 0.07);
			background: rgba(255, 255, 255, 0.03);
		}

		.guide-step strong {
			display: block;
			font-size: 1rem;
			letter-spacing: -0.02em;
		}

		.guide-step span {
			display: block;
			margin-top: 8px;
			font-size: 0.9rem;
			color: var(--muted);
			line-height: 1.65;
		}

		.guide-step.is-source strong {
			color: #91ecff;
		}

		.guide-step.is-proxy strong {
			color: #8ef5d9;
		}

		.guide-step.is-target strong {
			color: #ffd08b;
		}

		.guide-arrow {
			font-size: 1.5rem;
			font-weight: 700;
			color: rgba(97, 219, 255, 0.82);
		}

		.guide-flow-caption {
			grid-column: 1 / -1;
			margin: 2px 0 0;
			text-align: center;
			color: var(--muted);
			line-height: 1.8;
		}

		.guide-list {
			margin: 14px 0 0;
			padding-left: 20px;
			color: var(--text-soft);
			line-height: 1.8;
		}

		.guide-list li + li {
			margin-top: 8px;
		}

		.guide-list li::marker {
			color: var(--accent-strong);
		}

		.guide-tip {
			margin-top: 18px;
			padding: 18px 20px;
			border-radius: 22px;
			border: 1px solid rgba(97, 219, 255, 0.16);
			background:
				linear-gradient(90deg, rgba(97, 219, 255, 0.1), rgba(45, 212, 191, 0.08), rgba(255, 184, 105, 0.08)),
				rgba(255, 255, 255, 0.02);
			color: #d7edf9;
			line-height: 1.8;
		}

		.guide-tip strong {
			color: #ffffff;
		}

		.result-item {
			position: relative;
			overflow: hidden;
			padding: 22px 24px;
			border-radius: 28px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 42%),
				var(--panel-strong);
			box-shadow: var(--shadow-soft);
			display: flex;
			gap: 20px;
			transition: transform 0.2s ease, box-shadow 0.2s ease;
		}

		.result-item:hover {
			transform: translateY(-2px);
			box-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
			border-color: rgba(255, 255, 255, 0.12);
		}

		.result-checkbox-wrapper {
			display: flex;
			align-items: center;
			justify-content: center;
			padding-top: 2px;
		}

		.result-checkbox {
			appearance: none;
			width: 20px;
			height: 20px;
			border: 2px solid rgba(255, 255, 255, 0.18);
			border-radius: 6px;
			background: rgba(255, 255, 255, 0.04);
			cursor: pointer;
			position: relative;
			transition: all 0.2s ease;
		}

		.result-checkbox:checked {
			background: var(--accent);
			border-color: var(--accent);
		}

		.result-checkbox:checked::after {
			content: '✓';
			position: absolute;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			color: #052538;
			font-size: 12px;
			font-weight: 900;
		}

		.result-main {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
		}

		.result-item::before {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			bottom: 0;
			width: 4px;
			background: rgba(144, 180, 212, 0.28);
			transition: background 0.3s ease;
		}

		.result-item.success::before {
			background: linear-gradient(180deg, #34d399, #10b981);
		}

		.result-item.error::before {
			background: linear-gradient(180deg, #fb7185, #ef4444);
		}

		/* 移除旧的背景模糊效果 */
		.result-flag-overlay {
			display: none;
		}

		.result-top {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 16px;
		}

		.result-info {
			display: flex;
			flex-direction: column;
			gap: 6px;
			min-width: 0;
		}

		.result-label {
			font-size: 0.74rem;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--muted);
		}

		.result-ip {
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', monospace;
			font-size: 1.08rem;
			font-weight: 700;
			word-break: break-word;
		}

		.result-detail {
			color: var(--muted);
			font-size: 0.94rem;
			line-height: 1.75;
		}

		.result-detail.is-compact {
			font-size: 0.88rem;
		}

		.status-badge {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-width: 72px;
			padding: 8px 14px;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.06);
			font-family: 'Space Grotesk', sans-serif;
			font-size: 0.88rem;
			font-weight: 700;
			color: #ffffff;
			white-space: nowrap;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
		}

		.status-success {
			background: rgba(52, 211, 153, 0.14);
			border-color: rgba(52, 211, 153, 0.28);
			color: #a5f3cf;
		}

		/* 延迟分级样式 */
		.latency-low {
			background: rgba(52, 211, 153, 0.18);
			border-color: rgba(52, 211, 153, 0.34);
			color: #34d399;
			box-shadow: 0 4px 14px rgba(52, 211, 153, 0.18);
		}

		.latency-mid {
			background: rgba(251, 191, 36, 0.14);
			border-color: rgba(251, 191, 36, 0.28);
			color: #fbbf24;
		}

		.latency-high {
			background: rgba(251, 113, 133, 0.14);
			border-color: rgba(251, 113, 133, 0.28);
			color: #fb7185;
		}

		.status-error {
			background: rgba(251, 113, 133, 0.12);
			border-color: rgba(251, 113, 133, 0.24);
			color: #fecdd7;
		}

		.status-pending {
			background: rgba(251, 191, 36, 0.12);
			border-color: rgba(251, 191, 36, 0.22);
			color: #fde68a;
		}

		.result-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 14px;
		}

		.meta-chip {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-radius: 999px;
			background: rgba(97, 219, 255, 0.07);
			border: 1px solid rgba(97, 219, 255, 0.12);
			color: var(--text-soft);
			font-size: 0.82rem;
		}

		.meta-chip svg {
			width: 14px;
			height: 14px;
			flex: none;
			opacity: 0.92;
		}

		.meta-chip-strong {
			background: rgba(97, 219, 255, 0.12);
			border-color: rgba(97, 219, 255, 0.22);
			color: #dff9ff;
		}

		.meta-chip-danger {
			background: rgba(251, 113, 133, 0.1);
			border-color: rgba(251, 113, 133, 0.22);
			color: #ffd1d8;
		}

		.exit-list {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 14px;
			align-items: center;
		}

		.exit-list-label {
			color: var(--muted);
			font-size: 0.84rem;
		}

		.exit-ip-btn {
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 12px;
			padding: 8px 14px;
			background: rgba(255, 255, 255, 0.04);
			color: var(--text);
			font-family: 'Space Grotesk', monospace;
			font-size: 0.92rem;
			font-weight: 700;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			gap: 8px;
			transition: all 0.2s ease;
		}

		.exit-ip-btn:hover {
			transform: translateY(-1px);
			border-color: rgba(97, 219, 255, 0.32);
			background: rgba(97, 219, 255, 0.08);
		}

		.exit-ip-btn.is-active {
			border-color: var(--accent);
			background: rgba(97, 219, 255, 0.14);
			box-shadow: 0 0 16px rgba(97, 219, 255, 0.12);
		}

		.copy-btn {
			padding: 6px;
			border-radius: 8px;
			border: 1px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			transition: all 0.2s ease;
		}

		.copy-btn:hover {
			color: var(--accent);
			background: rgba(97, 219, 255, 0.1);
			border-color: rgba(97, 219, 255, 0.2);
		}

		.copy-btn svg {
			width: 14px;
			height: 14px;
		}

		/* 底部国旗标签样式重构 */
		.result-footer-tag {
			position: absolute;
			bottom: 20px;
			right: 24px;
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 8px 16px;
			border-radius: 14px;
			background: rgba(0, 0, 0, 0.45);
			border: 1px solid rgba(255, 255, 255, 0.12);
			backdrop-filter: blur(14px);
			font-size: 0.82rem;
			font-weight: 700;
			color: #ffffff;
			pointer-events: none;
			opacity: 0;
			transform: translateY(10px);
			transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
			z-index: 10;
		}

		.result-item.success .result-footer-tag {
			opacity: 1;
			transform: translateY(0);
		}

		.footer-flag {
			width: 52px; /* 放大约 3 倍 */
			height: auto;
			border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
			order: 2; /* 国旗在后 */
		}

		.footer-text {
			order: 1; /* 文字在前 */
			letter-spacing: 0.02em;
			text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
		}

		.map-container-wrapper {
			display: none;
			margin-top: 16px;
			height: 330px;
			border-radius: 22px;
			overflow: hidden;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(255, 255, 255, 0.03);
		}

		#map-template {
			display: none;
		}

		#global-map {
			width: 100%;
			height: 100%;
			background: #09111d;
		}

		#global-map .leaflet-tile-pane {
			filter: invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.96) saturate(0.88);
		}

		.map-popup {
			font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
			font-size: 0.88rem;
			line-height: 1.65;
			color: #10253d;
		}

		.map-popup b {
			color: #081826;
		}

		.leaflet-control-zoom {
			display: none !important;
		}

		.leaflet-control-attribution {
			display: block !important;
			margin: 0 !important;
			padding: 4px 8px !important;
			border-radius: 12px 0 0 0;
			background: rgba(9, 17, 29, 0.78) !important;
			backdrop-filter: blur(10px);
			box-shadow: 0 10px 24px rgba(3, 7, 18, 0.22);
			color: rgba(223, 240, 255, 0.84) !important;
			font-size: 11px;
			line-height: 1.4;
		}

		.leaflet-control-attribution a {
			color: inherit !important;
		}

		.site-footer {
			padding-top: 22px;
			font-size: 0.9rem;
		}

		.site-footer a,
		#visit-count {
			color: #bff4ff;
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			font-weight: 600;
			letter-spacing: -0.02em;
			font-variant-numeric: tabular-nums;
		}

		.site-footer a {
			text-decoration: none;
			border-bottom: 1px solid rgba(191, 244, 255, 0.28);
		}

		.site-footer a:hover {
			color: #ffffff;
			border-bottom-color: rgba(255, 255, 255, 0.42);
		}

		html[data-theme='light'] .brand-chip {
			border-color: rgba(86, 124, 158, 0.18);
			background: rgba(255, 255, 255, 0.76);
			color: #1d5d83;
		}

		html[data-theme='light'] .brand-title {
			color: #10253d;
		}

		html[data-theme='light'] .theme-toggle {
			background: transparent;
			border-color: transparent;
			box-shadow: none;
		}

		html[data-theme='light'] .surface-card {
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.72)),
				var(--panel);
		}

		html[data-theme='light'] .section-kicker,
		html[data-theme='light'] .guide-card-label {
			color: #0f7ab8;
		}

		html[data-theme='light'] .section-kicker::before,
		html[data-theme='light'] .guide-card-label::before {
			background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.72));
		}

		html[data-theme='light'] .panel-badge,
		html[data-theme='light'] .guide-badge {
			background: rgba(14, 165, 233, 0.08);
			border-color: rgba(14, 165, 233, 0.16);
			color: #0f5f8e;
		}

		html[data-theme='light'] .field-label {
			color: #17324a;
		}

		html[data-theme='light'] .input-control {
			background: rgba(255, 255, 255, 0.82);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
		}

		html[data-theme='light'] .input-control::placeholder {
			color: #7b8fa3;
		}

		html[data-theme='light'] .input-control:focus {
			background: #ffffff;
			border-color: rgba(14, 165, 233, 0.3);
			box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.1);
		}

		html[data-theme='light'] .history-toggle {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.78);
			color: #5b738b;
		}

		html[data-theme='light'] .history-toggle:hover {
			color: #10253d;
			background: rgba(14, 165, 233, 0.1);
		}

		html[data-theme='light'] .history-dropdown {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.96);
			box-shadow: 0 20px 36px rgba(43, 67, 91, 0.16);
		}

		html[data-theme='light'] .history-item:hover {
			background: rgba(14, 165, 233, 0.08);
			color: #10253d;
		}

		html[data-theme='light'] .history-item.is-empty {
			color: #7f92a6;
		}

		html[data-theme='light'] .mode-card,
		html[data-theme='light'] .progress-container,
		html[data-theme='light'] .metric-card,
		html[data-theme='light'] .results-empty,
		html[data-theme='light'] .guide-flow,
		html[data-theme='light'] .guide-step,
		html[data-theme='light'] .map-container-wrapper {
			background: rgba(255, 255, 255, 0.62);
			border-color: rgba(95, 123, 150, 0.14);
		}

		html[data-theme='light'] .slider {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(95, 123, 150, 0.14);
		}

		html[data-theme='light'] .slider::before {
			background: #ffffff;
			box-shadow: 0 6px 14px rgba(43, 67, 91, 0.18);
		}

		html[data-theme='light'] .primary-btn {
			box-shadow: 0 18px 34px rgba(14, 165, 233, 0.18);
		}

		html[data-theme='light'] .primary-btn:hover {
			box-shadow: 0 22px 40px rgba(14, 165, 233, 0.22);
		}

		html[data-theme='light'] .results-pill {
			border-color: rgba(95, 123, 150, 0.16);
			background: rgba(255, 255, 255, 0.72);
			color: #16324a;
		}

		html[data-theme='light'] .results-pill.state-idle {
			color: #365168;
		}

		html[data-theme='light'] .results-pill.state-resolving {
			background: rgba(245, 158, 11, 0.12);
			border-color: rgba(245, 158, 11, 0.18);
			color: #9a6706;
		}

		html[data-theme='light'] .results-pill.state-running {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(14, 165, 233, 0.18);
			color: #0f5f8e;
		}

		html[data-theme='light'] .results-pill.state-done {
			background: rgba(5, 150, 105, 0.12);
			border-color: rgba(5, 150, 105, 0.18);
			color: #047857;
		}

		html[data-theme='light'] .results-pill.state-empty,
		html[data-theme='light'] .results-pill.state-error {
			background: rgba(225, 29, 72, 0.1);
			border-color: rgba(225, 29, 72, 0.16);
			color: #be123c;
		}

		html[data-theme='light'] .empty-visual {
			background:
				radial-gradient(circle at 30% 30%, rgba(14, 165, 233, 0.18), transparent 42%),
				linear-gradient(160deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.4));
			border-color: rgba(95, 123, 150, 0.14);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
		}

		html[data-theme='light'] .empty-visual span:nth-child(1) {
			background: rgba(14, 165, 233, 0.18);
		}

		html[data-theme='light'] .empty-visual span:nth-child(2) {
			background: rgba(20, 184, 166, 0.28);
		}

		html[data-theme='light'] .empty-visual span:nth-child(3) {
			background: rgba(16, 37, 61, 0.12);
		}

		html[data-theme='light'] .guide-shell::before {
			background:
				radial-gradient(circle at top right, rgba(14, 165, 233, 0.1), transparent 30%),
				radial-gradient(circle at bottom left, rgba(20, 184, 166, 0.08), transparent 28%);
		}

		html[data-theme='light'] .guide-card {
			border-color: rgba(95, 123, 150, 0.14);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.74);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
		}

		html[data-theme='light'] .guide-card-accent {
			background:
				radial-gradient(circle at top left, rgba(14, 165, 233, 0.12), transparent 38%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.78);
		}

		html[data-theme='light'] .guide-card-warm {
			background:
				radial-gradient(circle at top right, rgba(245, 158, 11, 0.12), transparent 34%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.78);
		}

		html[data-theme='light'] .guide-card a,
		html[data-theme='light'] .site-footer a,
		html[data-theme='light'] #visit-count {
			color: #0f7ab8;
			border-bottom-color: rgba(14, 165, 233, 0.24);
		}

		html[data-theme='light'] .guide-card a:hover,
		html[data-theme='light'] .site-footer a:hover {
			color: #10253d;
			border-bottom-color: rgba(16, 37, 61, 0.2);
		}

		html[data-theme='light'] .guide-quote {
			border-color: rgba(245, 158, 11, 0.16);
			background: rgba(245, 158, 11, 0.08);
			color: #9a6706;
		}

		html[data-theme='light'] .guide-step.is-source strong {
			color: #0284c7;
		}

		html[data-theme='light'] .guide-step.is-proxy strong {
			color: #0f766e;
		}

		html[data-theme='light'] .guide-step.is-target strong {
			color: #b45309;
		}

		html[data-theme='light'] .guide-arrow {
			color: rgba(14, 165, 233, 0.56);
		}

		html[data-theme='light'] .guide-tip {
			border-color: rgba(14, 165, 233, 0.14);
			background:
				linear-gradient(90deg, rgba(14, 165, 233, 0.08), rgba(20, 184, 166, 0.06), rgba(245, 158, 11, 0.06)),
				rgba(255, 255, 255, 0.62);
			color: #365168;
		}

		html[data-theme='light'] .guide-tip strong {
			color: #10253d;
		}

		html[data-theme='light'] .result-item {
			border-color: rgba(95, 123, 150, 0.14);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.88), transparent 38%),
				var(--panel-strong);
		}

		html[data-theme='light'] .result-item::before {
			background: rgba(121, 140, 159, 0.38);
		}

		html[data-theme='light'] .status-badge {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.72);
			color: #16324a;
		}

		html[data-theme='light'] .status-success {
			background: rgba(5, 150, 105, 0.12);
			border-color: rgba(5, 150, 105, 0.16);
			color: #047857;
		}

		html[data-theme='light'] .status-error {
			background: rgba(225, 29, 72, 0.1);
			border-color: rgba(225, 29, 72, 0.16);
			color: #be123c;
		}

		html[data-theme='light'] .status-pending {
			background: rgba(245, 158, 11, 0.12);
			border-color: rgba(245, 158, 11, 0.16);
			color: #9a6706;
		}

		html[data-theme='light'] .meta-chip {
			background: rgba(14, 165, 233, 0.08);
			border-color: rgba(14, 165, 233, 0.12);
			color: #23415a;
		}

		html[data-theme='light'] .meta-chip-strong {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(14, 165, 233, 0.18);
			color: #075985;
		}

		html[data-theme='light'] .meta-chip-danger {
			background: rgba(225, 29, 72, 0.08);
			border-color: rgba(225, 29, 72, 0.14);
			color: #be123c;
		}

		html[data-theme='light'] .exit-ip-btn {
			border-color: rgba(5, 150, 105, 0.18);
			background: linear-gradient(135deg, rgba(5, 150, 105, 0.08), rgba(14, 165, 233, 0.08));
			color: #17324a;
		}

		html[data-theme='light'] .exit-ip-btn:hover {
			border-color: rgba(14, 165, 233, 0.24);
			background: linear-gradient(135deg, rgba(5, 150, 105, 0.12), rgba(14, 165, 233, 0.12));
		}

		html[data-theme='light'] .exit-ip-btn.is-active {
			border-color: rgba(14, 165, 233, 0.32);
			background: linear-gradient(135deg, rgba(14, 165, 233, 0.18), rgba(5, 150, 105, 0.12));
			box-shadow: inset 0 0 0 1px rgba(14, 165, 233, 0.1), 0 0 0 1px rgba(14, 165, 233, 0.08);
		}

		html[data-theme='light'] #global-map {
			background: #dfeaf3;
		}

		html[data-theme='light'] #global-map .leaflet-tile-pane {
			filter: none;
		}

		html[data-theme='light'] .leaflet-control-attribution {
			background: rgba(255, 255, 255, 0.92) !important;
			box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
			color: rgba(15, 23, 42, 0.72) !important;
		}

		@media (max-width: 980px) {
			.workspace-grid {
				grid-template-columns: 1fr;
			}

			.header-note {
				text-align: left;
				max-width: none;
			}

			.guide-grid {
				grid-template-columns: 1fr;
			}

		}

		@media (max-width: 720px) {
			.page-shell {
				padding: 22px 14px 32px;
			}

			.header-note {
				flex: none;
			}

			.results-list:not(:empty) {
				margin-top: 18px;
			}

			.site-header,
			.panel-header,
			.results-header,
			.guide-header,
			.control-row,
			.results-empty,
			.result-top {
				flex-direction: column;
			}

			.site-header,
			.panel-header,
			.results-header,
			.guide-header,
			.control-row {
				align-items: stretch;
			}

			.control-panel,
			.side-card,
			.results-shell,
			.guide-shell {
				padding: 22px;
			}

			.mode-card {
				min-width: 0;
			}

			.progress-head {
				flex-direction: column;
				align-items: flex-start;
			}

			.guide-flow {
				grid-template-columns: 1fr;
				padding: 20px;
			}

			.guide-arrow {
				display: none;
			}
		}

		@media (max-width: 560px) {
			.meta-chip,
			.exit-ip-btn {
				width: 100%;
				justify-content: center;
			}

			.results-empty {
				grid-template-columns: 1fr;
				text-align: center;
			}

			.empty-visual {
				margin: 0 auto;
			}

			.summary-grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 10px;
			}

			.metric-card {
				padding: 14px;
			}
		}
		.proxy-search-shell {
			margin-top: 0;
			margin-bottom: 24px;
			padding: 28px;
			position: relative;
			overflow: hidden;
			z-index: 10;
		}

		.proxy-search-shell::before {
			content: '';
			position: absolute;
			inset: 0;
			background:
				radial-gradient(circle at top right, rgba(251, 191, 36, 0.12), transparent 30%),
				radial-gradient(circle at bottom left, rgba(97, 219, 255, 0.12), transparent 28%);
			pointer-events: none;
		}

		.proxy-search-header,
		.proxy-search-form {
			position: relative;
			z-index: 1;
		}

		.proxy-search-header {
			display: flex;
			align-items: center;
			gap: 0;
			flex-wrap: wrap;
			margin-bottom: 0;
		}

		.proxy-search-form {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: center;
			gap: 16px;
			margin-top: 18px;
		}

		.proxy-search-field {
			flex: 1 1 180px;
			min-width: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
		}

		.proxy-search-custom-field {
			flex: 0 1 170px;
		}

		.proxy-search-control {
			min-height: 58px;
			padding: 0 48px 0 18px;
			border-radius: 18px;
		}

		select.proxy-search-control {
			appearance: none;
			background-image:
				linear-gradient(45deg, transparent 50%, currentColor 50%),
				linear-gradient(135deg, currentColor 50%, transparent 50%);
			background-position:
				calc(100% - 23px) 50%,
				calc(100% - 17px) 50%;
			background-size: 6px 6px, 6px 6px;
			background-repeat: no-repeat;
			color: var(--text);
		}

		.proxy-search-input {
			padding-right: 18px;
			text-transform: uppercase;
		}

		.proxy-search-input:disabled {
			cursor: not-allowed;
			opacity: 0.72;
			color: var(--text-soft);
		}

		.proxy-search-btn {
			flex: 0 0 160px;
			min-height: 58px;
			border-radius: 18px;
			font-size: 1rem;
		}

		html[data-theme='light'] .proxy-search-shell::before {
			background:
				radial-gradient(circle at top right, rgba(245, 158, 11, 0.08), transparent 30%),
				radial-gradient(circle at bottom left, rgba(14, 165, 233, 0.08), transparent 28%);
		}

		@media (max-width: 720px) {
			.proxy-search-header {
				flex-direction: column;
				align-items: stretch;
				gap: 8px;
			}
			.proxy-search-shell {
				padding: 22px;
			}
		}

		@media (max-width: 560px) {
			.proxy-search-btn {
				flex-basis: 100%;
			}
		}
	</style>
</head>
<body>
	<div class="page-shell">
		<div class="ambient ambient-one"></div>
		<div class="ambient ambient-two"></div>

		<header class="site-header">
			<button class="theme-toggle" type="button" id="themeToggle" aria-label="切换日间和夜间模式" title="切换日间和夜间模式">
				<span class="theme-toggle-switch" aria-hidden="true">
					<svg class="theme-toggle-icon theme-toggle-icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="4"></circle>
						<path d="M12 2v2"></path>
						<path d="M12 20v2"></path>
						<path d="m4.93 4.93 1.41 1.41"></path>
						<path d="m17.66 17.66 1.41 1.41"></path>
						<path d="M2 12h2"></path>
						<path d="M20 12h2"></path>
						<path d="m6.34 17.66-1.41 1.41"></path>
						<path d="m19.07 4.93-1.41 1.41"></path>
					</svg>
					<span class="theme-toggle-thumb"></span>
					<svg class="theme-toggle-icon theme-toggle-icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
					</svg>
				</span>
			</button>
		</header>

		<main class="site-main">
			<section class="surface-card proxy-search-shell">
				<div class="proxy-search-header">
					<h2 class="results-title" style="white-space:nowrap;">获取更多 ProxyIP</h2>
					<div style="flex:1; display:flex; justify-content:center; padding: 0 20px;">
						<p class="results-subtitle" style="margin:0;">按端口和地区从网络测绘数据库中发现候选 ProxyIP，方便继续放回本工具检测可用性。</p>
					</div>
				</div>

				<div class="proxy-search-form">
					<label class="proxy-search-field" for="proxyRegionSelect">
						<span class="field-label">地区:</span>
						<select class="input-control proxy-search-control" id="proxyRegionSelect">
							<option value="custom">✍️ 自定义地区</option>
							<optgroup label="🌏 亚洲 / AS">
								<option value="HK" selected>🇭🇰 香港</option>
								<option value="TW">🇨🇳 台湾</option>
								<option value="KR">🇰🇷 韩国</option>
								<option value="JP">🇯🇵 日本</option>
								<option value="SG">🇸🇬 新加坡</option>
								<option value="IN">🇮🇳 印度</option>
							</optgroup>
							<optgroup label="🌎 北美 / NA">
								<option value="US">🇺🇸 美国</option>
								<option value="CA">🇨🇦 加拿大</option>
							</optgroup>
							<optgroup label="🌍 欧洲 / EU">
								<option value="GB">🇬🇧 英国</option>
								<option value="DE">🇩🇪 德国</option>
								<option value="FR">🇫🇷 法国</option>
							</optgroup>
							<optgroup label="🌏 大洋洲 / OC">
								<option value="AU">🇦🇺 澳大利亚</option>
							</optgroup>
						</select>
					</label>

					<label class="proxy-search-field proxy-search-custom-field" for="customRegionInput" id="customRegionField">
						<span class="field-label">国家代码:</span>
						<input class="input-control proxy-search-control proxy-search-input" type="text" id="customRegionInput" maxlength="2" pattern="[A-Za-z]{2}" placeholder="US" autocomplete="off" inputmode="text">
					</label>

					<label class="proxy-search-field" for="proxyPortSelect">
						<span class="field-label">端口:</span>
						<select class="input-control proxy-search-control" id="proxyPortSelect">
							<option value="443">443</option>
							<option value="nonstandard">非标</option>
						</select>
					</label>
					<button class="primary-btn proxy-search-btn" id="fofaBtn" type="button">FOFA</button>
				</div>
			</section>
			<section class="workspace-grid">
				<div class="surface-card control-panel">

					<div class="input-zone">
						<div class="input-zone-header">
							<div style="display: flex; align-items: center;">
								<label class="field-label" for="inputList">ProxyIP / 域名目标</label>
								<button class="clear-btn" type="button" id="clearInputBtn" title="清空输入框内容">清空</button>
							</div>
							<button class="preset-toggle-btn" type="button" id="presetToggleBtn">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
								<span>内置反代域名</span>
								<svg class="preset-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
							</button>
						</div>

						<div class="input-body" id="inputBody">
							<div class="input-col">
								<div class="input-wrapper" id="inputContainer">
									<textarea class="input-control" id="inputList" placeholder="例如：ProxyIP.CMLiussss.net 或 8.223.63.150:443"></textarea>
								</div>
							</div>

							<div class="preset-col" id="presetCol">
								<div class="preset-dropdown" id="presetDropdown">
									<div class="preset-header">
										<label class="preset-check-all">
											<input type="checkbox" id="presetSelectAll"> <span>全选</span>
										</label>
									</div>
									<div class="preset-list" id="presetList"></div>
								</div>
							</div>
						</div>
					</div>

					<div class="control-row">
						<div class="mode-card">
							<div class="mode-copy">
								<strong>批量检测</strong>
								<div class="mode-state" id="modeLabel">Single / 单目标</div>
							</div>
							<label class="switch">
								<input type="checkbox" id="batchMode" checked>
								<span class="slider"></span>
							</label>
						</div>

						<button class="primary-btn" id="checkBtn" type="button">
							<span>开始检测</span>
							<small>Resolve + Check</small>
						</button>
					</div>

				</div>

				<aside class="side-column">
					<div class="surface-card side-card">
						<p class="section-kicker">Summary</p>
						<h3 class="summary-title" id="summaryHeadline">等待输入</h3>
						<p class="summary-description" id="summaryDescription">实时统计和检测概览。</p>
						<div id="progressContainer" class="progress-container">
							<div class="progress-head">
								<span>检测进度</span>
								<span id="progressText">尚未开始</span>
							</div>
							<div class="progress-track">
								<div id="progressBar" class="progress-bar"></div>
							</div>
						</div>
						<div class="summary-grid">
							<div class="metric-card">
								<span>目标数</span>
								<strong id="statTotal">0</strong>
							</div>
							<div class="metric-card">
								<span>有效</span>
								<strong id="statSuccess">0</strong>
							</div>
							<div class="metric-card">
								<span>待完成</span>
								<strong id="statPending">0</strong>
							</div>
							<div class="metric-card">
								<span>失败</span>
								<strong id="statFailed">0</strong>
							</div>
						</div>
					</div>
				</aside>
			</section>

			<section class="surface-card results-shell">
				<div class="results-header">
					<div>
						<p class="section-kicker">Results</p>
						<h2 class="results-title">检测结果</h2>
						<p class="results-subtitle" id="resultMeta">结果、落地 IP 和地图会在这里按检测进度逐步展开。</p>
					</div>
					<div class="results-pill state-idle" id="resultPill">Idle</div>
				</div>

				<!-- 新增操作栏 -->
				<div class="results-controls" id="resultsControls" style="display: none;">
					<div class="control-group">
						<button class="control-btn" id="selectAllBtn">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
							<span>全选</span>
						</button>
						<button class="control-btn" id="sortBtn">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-3 3-3-3"></path><path d="m15 6-3-3-3 3"></path><path d="M12 3v18"></path></svg>
							<span>排序: 默认</span>
						</button>
					</div>
					<div class="filter-group">
						<span class="filter-label">筛选:</span>
						<div class="filter-pill active" data-max="999999">全部</div>
						<div class="filter-pill" data-max="50">&lt; 50ms</div>
						<div class="filter-pill" data-max="100">&lt; 100ms</div>
						<div class="filter-pill" data-max="150">&lt; 150ms</div>
						<div class="filter-pill" data-max="250">&lt; 250ms</div>
						<button class="control-btn" id="copySelectedBtn" style="margin-left: 8px;">
							<span>复制选中</span>
						</button>
					</div>
				</div>

				<div class="results-empty" id="resultsEmpty">
					<div class="empty-visual" aria-hidden="true">
						<span></span>
						<span></span>
						<span></span>
					</div>
					<div class="empty-copy">
						<h3 id="emptyStateTitle">等待开始检测</h3>
						<p id="emptyStateDescription">输入目标后，检测结果、出口信息和地图会在这里展示。</p>
					</div>
				</div>

				<div id="results" class="results-list"></div>
			</section>

			<section class="surface-card guide-shell">
				<div class="guide-header">
					<div>
						<p class="section-kicker">Guide</p>
						<h2 class="results-title">什么是 ProxyIP</h2>
						<p class="results-subtitle">用一段更接近实际部署场景的说明，快速理解 ProxyIP 的定义、作用和筛选标准。</p>
					</div>
					<div class="guide-badge">Cloudflare Workers / TCP</div>
				</div>

				<div class="guide-grid">
					<article class="guide-card guide-card-accent">
						<div class="guide-card-label">概念</div>
						<h3>ProxyIP 是一个可被验证的中转入口</h3>
						<p>在 Cloudflare Workers 的使用语境里，ProxyIP 通常指那些能够成功代理到 Cloudflare 服务的第三方 IP。它不是 Cloudflare 官方分配给你的接入地址，而是一个可以替你完成转发的外部节点。</p>
					</article>

					<article class="guide-card guide-card-warm">
						<div class="guide-card-label">限制来源</div>
						<h3>为什么很多场景会专门去找 ProxyIP</h3>
						<p>Cloudflare Workers 的 <a href="https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/" target="_blank" rel="noreferrer">TCP sockets 文档</a> 明确提到，指向 <a href="https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/" target="_blank" rel="noreferrer">Cloudflare IP ranges</a> 的出站 TCP 连接会被阻止。也就是说，某些依赖直连 Cloudflare IP 的链路，不能在 Workers 里直接打通。</p>
						<div class="guide-quote">Outbound TCP sockets to Cloudflare IP ranges are blocked.</div>
					</article>
				</div>

				<div class="guide-flow">
					<div class="guide-step is-source">
						<strong>Cloudflare Workers</strong>
						<span>发起请求，尝试访问目标服务</span>
					</div>
					<div class="guide-arrow" aria-hidden="true">→</div>
					<div class="guide-step is-proxy">
						<strong>ProxyIP 节点</strong>
						<span>位于第三方网络，负责中转和反向代理</span>
					</div>
					<div class="guide-arrow" aria-hidden="true">→</div>
					<div class="guide-step is-target">
						<strong>Cloudflare 服务</strong>
						<span>最终被访问的站点、边缘服务或 CDN 目标</span>
					</div>
					<p class="guide-flow-caption">实际作用可以理解为：让 Workers 先连到第三方节点，再由该节点替你把流量送到 Cloudflare 侧，绕开直连 Cloudflare IP 的限制。</p>
				</div>

				<div class="guide-grid guide-grid-secondary">
					<article class="guide-card">
						<div class="guide-card-label">应用场景</div>
						<h3>为什么像 edgetunnel、epeius 这类项目会用到它</h3>
						<p>当目标网站本身走的是 Cloudflare CDN 或 Cloudflare 边缘网络时，项目如果需要直接建立到目标地址的 TCP 连接，就可能因为上述限制而失败。配置可用的 ProxyIP 后，这类项目就能借助中转节点继续完成访问。</p>
					</article>

					<article class="guide-card">
						<div class="guide-card-label">有效特征</div>
						<h3>有效的 ProxyIP，通常至少满足这些条件</h3>
						<ul class="guide-list">
							<li>能够成功建立代理到指定端口（通常为 443）的 TCP 连接</li>
							<li>具备反向代理 Cloudflare IP 段的 HTTPS 服务能力</li>
						</ul>
					</article>
				</div>

				<div class="guide-tip">
					<strong>这页检测的意义：</strong>本工具不是只做静态解析，而是尽量模拟真实链路去验证目标是否真的可用，帮助你更快筛掉“看起来在线、实际不可做代理”的候选 IP。
				</div>
			</section>
		</main>

		<footer class="site-footer">
			<div>© 2025 - 2026 Check ProxyIP · 基于 Cloudflare Workers 构建与运行 · 今日访问人数：<span id="visit-count">···</span> · 站点维护：<a href="https://t.me/CMLiussss" target="_blank" rel="noreferrer">CMLiussss</a></div>
		</footer>
	</div>

	<div id="map-template">
		<div id="global-map"></div>
	</div>

	<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
	<script>
		const checkBtn = document.getElementById('checkBtn');
		let inputList = document.getElementById('inputList');
		const inputContainer = document.getElementById('inputContainer');
		const batchMode = document.getElementById('batchMode');
		const resultsDiv = document.getElementById('results');
		const progressBar = document.getElementById('progressBar');
		const progressText = document.getElementById('progressText');
		const globalMap = document.getElementById('global-map');
		const fieldHint = document.getElementById('fieldHint');
		const modeLabel = document.getElementById('modeLabel');
		const summaryHeadline = document.getElementById('summaryHeadline');
		const summaryDescription = document.getElementById('summaryDescription');
		const statTotal = document.getElementById('statTotal');
		const statSuccess = document.getElementById('statSuccess');
		const statPending = document.getElementById('statPending');
		const statFailed = document.getElementById('statFailed');
		const resultMeta = document.getElementById('resultMeta');
		const resultPill = document.getElementById('resultPill');
		const resultsEmpty = document.getElementById('resultsEmpty');
		const emptyStateTitle = document.getElementById('emptyStateTitle');
		const emptyStateDescription = document.getElementById('emptyStateDescription');
		const themeToggle = document.getElementById('themeToggle');
		const THEME_STORAGE_KEY = 'cf_proxy_theme';
		const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const BASE_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
		const BASE_MAP_TILE_OPTIONS = {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a> contributors'
		};

		let map = null;
		let mapLayers = [];
		let mapSvgRenderer = null;
		let cfLocationIndex = new Map();
		let cfLocationsPromise = null;
		let mapRenderToken = 0;
		let totalTargets = 0;
		let completedCount = 0;
		let successCount = 0;
		let inputCount = 0;
		let appState = 'idle';

		function getStoredTheme() {
			try {
				const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
				return storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : '';
			} catch {
				return '';
			}
		}

		function getSystemTheme() {
			return systemThemeQuery.matches ? 'dark' : 'light';
		}

		function applyTheme(theme, source) {
			const nextTheme = theme === 'light' ? 'light' : 'dark';
			const isDark = nextTheme === 'dark';

			document.documentElement.dataset.theme = nextTheme;
			document.documentElement.style.colorScheme = nextTheme;

			if (!themeToggle) return;

			themeToggle.setAttribute('aria-pressed', String(isDark));
			themeToggle.setAttribute(
				'aria-label',
				isDark
					? '当前为夜间模式，点击切换到日间模式。'
					: '当前为日间模式，点击切换到夜间模式。'
			);
			themeToggle.title = source === 'stored'
				? (isDark ? '夜间模式，已保存到本地' : '日间模式，已保存到本地')
				: (isDark ? '夜间模式，当前跟随系统' : '日间模式，当前跟随系统');
		}

		function initializeTheme() {
			const storedTheme = getStoredTheme();
			applyTheme(storedTheme || getSystemTheme(), storedTheme ? 'stored' : 'system');
		}

		initializeTheme();

		function getVisitStatsId() {
			const hostname = String(window.location.hostname || window.location.host || '').trim().toLowerCase();
			return hostname || 'unknown-host';
		}

		async function fetchVisitCount() {
			const visitCountElement = document.getElementById('visit-count');
			if (!visitCountElement) return;

			try {
				const response = await fetch('https://tongji.090227.xyz/?id=' + encodeURIComponent(getVisitStatsId()));
				if (!response.ok) {
					throw new Error('Failed to load visit count: ' + response.status);
				}

				const data = await response.json();
				if (data && data.visitCount !== undefined) {
					visitCountElement.textContent = data.visitCount;
					return;
				}

				throw new Error('visitCount is missing in response');
			} catch (error) {
				console.error('Failed to fetch visit count', error);
				visitCountElement.textContent = '加载失败';
			}
		}

		function initMap() {
			if (map) return;
			map = L.map('global-map', {
				zoomControl: false,
				attributionControl: true
			}).setView([20, 0], 2);
			map.attributionControl.setPrefix(false);
			// OpenStreetMap provides broader global coverage than AMap for international checks.
			L.tileLayer(BASE_MAP_TILE_URL, BASE_MAP_TILE_OPTIONS).addTo(map);
			mapSvgRenderer = L.svg();
			mapSvgRenderer.addTo(map);
		}

		function normalizeColoCode(value) {
			const code = String(value || '').trim().toUpperCase();
			return /^[A-Z0-9]{3,4}$/.test(code) ? code : '';
		}

		function isValidCoordinatePair(value) {
			return Array.isArray(value)
				&& value.length === 2
				&& value.every(function (entry) { return Number.isFinite(entry); })
				&& Math.abs(value[0]) <= 90
				&& Math.abs(value[1]) <= 180;
		}

		function parseCoordinatePair(value) {
			if (typeof value === 'string') {
				const parts = value.split(',').map(function (entry) {
					return Number(entry.trim());
				});
				return isValidCoordinatePair(parts) ? parts : null;
			}

			if (Array.isArray(value)) {
				const parts = value.map(function (entry) {
					return Number(entry);
				});
				return isValidCoordinatePair(parts) ? parts : null;
			}

			return null;
		}

		async function loadCfLocations() {
			if (cfLocationsPromise) {
				return cfLocationsPromise;
			}

			cfLocationsPromise = fetch('/locations')
				.then(function (response) {
					if (!response.ok) {
						throw new Error('Failed to load /locations: ' + response.status);
					}
					return response.json();
				})
				.then(function (payload) {
					const nextIndex = new Map();
					if (Array.isArray(payload)) {
						payload.forEach(function (entry) {
							const code = normalizeColoCode(entry?.iata);
							const lat = Number(entry?.lat);
							const lon = Number(entry?.lon);
							if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) {
								return;
							}
							nextIndex.set(code, {
								code: code,
								lat: lat,
								lon: lon,
								city: String(entry?.city || '').trim(),
								region: String(entry?.region || '').trim(),
								country: String(entry?.cca2 || '').trim()
							});
						});
					}
					cfLocationIndex = nextIndex;
					return nextIndex;
				})
				.catch(function (error) {
					console.error('Failed to preload Cloudflare locations', error);
					return cfLocationIndex;
				});

			return cfLocationsPromise;
		}

		function getCfLocation(coloCode) {
			const normalizedCode = normalizeColoCode(coloCode);
			if (!normalizedCode) {
				return null;
			}

			const location = cfLocationIndex.get(normalizedCode);
			return location ? {
				code: location.code,
				lat: location.lat,
				lon: location.lon,
				city: location.city,
				region: location.region,
				country: location.country
			} : null;
		}

		function clearMapLayers() {
			mapLayers.forEach(function (layer) {
				map.removeLayer(layer);
			});
			mapLayers = [];
		}

		function buildCfLocationLabel(cfLocation) {
			const country = getCountryNameInChinese(cfLocation?.country);
			const city = getCityNameInChinese(cfLocation?.city);
			return [city, cfLocation?.region, country].filter(Boolean).join(', ');
		}

		function ensureRouteArrowMarkerDef() {
			const overlaySvg = map?.getPanes?.().overlayPane?.querySelector('svg');
			if (!overlaySvg) {
				return '';
			}

			const svgNamespace = 'http://www.w3.org/2000/svg';
			let defs = overlaySvg.querySelector('defs');
			if (!defs) {
				defs = document.createElementNS(svgNamespace, 'defs');
				overlaySvg.insertBefore(defs, overlaySvg.firstChild);
			}

			const markerId = 'route-flow-arrowhead';
			if (!overlaySvg.querySelector('#' + markerId)) {
				const marker = document.createElementNS(svgNamespace, 'marker');
				marker.setAttribute('id', markerId);
				marker.setAttribute('viewBox', '0 0 10 10');
				marker.setAttribute('refX', '8');
				marker.setAttribute('refY', '5');
				marker.setAttribute('markerWidth', '7');
				marker.setAttribute('markerHeight', '7');
				marker.setAttribute('orient', 'auto');
				marker.setAttribute('markerUnits', 'strokeWidth');

				const arrowPath = document.createElementNS(svgNamespace, 'path');
				arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
				arrowPath.setAttribute('fill', '#8be9ff');
				arrowPath.setAttribute('fill-opacity', '0.95');

				marker.appendChild(arrowPath);
				defs.appendChild(marker);
			}

			return markerId;
		}

		function applyArrowStyleToPolyline(polyline) {
			const markerId = ensureRouteArrowMarkerDef();
			const pathElement = polyline?.getElement?.();
			if (!markerId || !pathElement) {
				return;
			}

			pathElement.setAttribute('marker-end', 'url(#' + markerId + ')');
			pathElement.setAttribute('stroke-linecap', 'round');
		}

		function createExitPopup(exitData) {
			const locationText = formatExitLocation(exitData) || 'Location unknown';
			const networkText = formatExitNetwork(exitData) || 'Network unknown';
			const coloCode = normalizeColoCode(exitData?.colo);
			const coloText = coloCode ? '<br>CF Colo: ' + escapeHtml(coloCode) : '';
			return '<div class="map-popup"><b>Exit IP</b><br>'
				+ escapeHtml(exitData?.ip || 'Unknown')
				+ '<br>' + escapeHtml(locationText)
				+ '<br>' + escapeHtml(networkText)
				+ coloText
				+ '</div>';
		}

		function createCfPopup(cfLocation) {
			const locationText = buildCfLocationLabel(cfLocation) || 'Location unknown';
			return '<div class="map-popup"><b>Cloudflare Colo</b><br>'
				+ escapeHtml(cfLocation?.code || 'Unknown')
				+ '<br>' + escapeHtml(locationText)
				+ '</div>';
		}

		function escapeHtml(value) {
			return String(value ?? '').replace(/[&<>"']/g, function (char) {
				return {
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;'
				}[char];
			});
		}

		function getMetaChipIcon(iconName) {
			const icons = {
				prep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path></svg>',
				location: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z"></path><circle cx="12" cy="11" r="2.5"></circle></svg>',
				network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="2"></rect><rect x="3" y="14" width="18" height="6" rx="2"></rect><circle cx="7" cy="7" r="1"></circle><circle cx="7" cy="17" r="1"></circle><path d="M12 10v4"></path></svg>',
				exits: '<svg viewBox="0 0 44 43" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M30.251 8.73438C30.251 6.13691 32.4057 4.03125 35.0635 4.03125C37.7214 4.03125 39.876 6.13691 39.876 8.73438C39.876 10.8649 38.4264 12.6646 36.4385 13.2427V15.4531C36.4385 19.1638 33.3605 22.1719 29.5635 22.1719H15.8135C13.5354 22.1719 11.6885 23.9767 11.6885 26.2031V29.7573C13.6764 30.3354 15.126 32.1351 15.126 34.2656C15.126 36.8631 12.9714 38.9688 10.3135 38.9688C7.65566 38.9688 5.50101 36.8631 5.50101 34.2656C5.50101 32.1351 6.95063 30.3354 8.93853 29.7573V13.2427C6.95063 12.6646 5.50101 10.8649 5.50101 8.73438C5.50101 6.13691 7.65566 4.03125 10.3135 4.03125C12.9714 4.03125 15.126 6.13691 15.126 8.73438C15.126 10.8649 13.6764 12.6646 11.6885 13.2427V20.8277C12.8376 19.9842 14.2658 19.4844 15.8135 19.4844H29.5635C31.8417 19.4844 33.6885 17.6795 33.6885 15.4531V13.2427C31.7006 12.6646 30.251 10.8649 30.251 8.73438Z" fill="currentColor"></path></svg>',
				error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg>',
				info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10v5"></path><circle cx="12" cy="7" r="1"></circle></svg>',
				retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 5v6h-6"></path><path d="M4 19v-6h6"></path><path d="M7 17a7 7 0 0 0 11-4"></path><path d="M17 7A7 7 0 0 0 6 11"></path></svg>'
			};
			return icons[iconName] || icons.info;
		}

		function buildMetaChip(text, iconName, modifierClass) {
			const className = modifierClass ? 'meta-chip ' + modifierClass : 'meta-chip';
			return '<span class="' + className + '">' + getMetaChipIcon(iconName) + '<span>' + escapeHtml(text) + '</span></span>';
		}

		function normalizeBatchInputValue(value) {
			return String(value ?? '')
				.replace(/\\r\\n?/g, '\\n')
				.replace(/[,\uFF0C]/g, '\\n')
				.split('\\n')
				.map(stripTargetLabel)
				.join('\\n');
		}

		function stripTargetLabel(value) {
			return String(value || '').split('#')[0].trim();
		}

		function normalizeBatchInputControl(control) {
			if (!control || control.tagName !== 'TEXTAREA') return;

			const rawValue = control.value;
			const nextValue = normalizeBatchInputValue(rawValue);

			if (nextValue === rawValue) return;

			const selectionStart = control.selectionStart ?? rawValue.length;
			const selectionEnd = control.selectionEnd ?? rawValue.length;
			const nextSelectionStart = normalizeBatchInputValue(rawValue.slice(0, selectionStart)).length;
			const nextSelectionEnd = normalizeBatchInputValue(rawValue.slice(0, selectionEnd)).length;

			control.value = nextValue;
			control.setSelectionRange(nextSelectionStart, nextSelectionEnd);
		}

		function bindInputShortcut() {
			inputList.addEventListener('input', function () {
				if (!batchMode.checked) return;
				normalizeBatchInputControl(inputList);
			});

			inputList.addEventListener('keydown', function (event) {
				const shouldRunSingle = !batchMode.checked && event.key === 'Enter';
				const shouldRunBatch = batchMode.checked && event.key === 'Enter' && (event.ctrlKey || event.metaKey);

				if (shouldRunSingle || shouldRunBatch) {
					event.preventDefault();
					checkBtn.click();
				}
			});
		}

		function setModeVisuals(isBatch) {
			modeLabel.innerText = isBatch ? 'Batch / 多目标' : 'Single / 单目标';
			fieldHint.innerText = isBatch
				? '批量模式下每行一个目标，按 Ctrl + Enter 直接开始检测。'
				: '单条模式下按 Enter 可以直接开始检测。';
		}

		function showEmptyState(title, description) {
			emptyStateTitle.innerText = title;
			emptyStateDescription.innerText = description;
			resultsEmpty.style.display = 'grid';
		}

		function hideEmptyState() {
			resultsEmpty.style.display = 'none';
		}

		function setAppState(nextState) {
			appState = nextState;
			renderDashboard();
		}

		function renderDashboard() {
			const failCount = Math.max(completedCount - successCount, 0);
			const pendingCount = Math.max(totalTargets - completedCount, 0);

			statTotal.innerText = String(totalTargets);
			statSuccess.innerText = String(successCount);
			statPending.innerText = String(pendingCount);
			statFailed.innerText = String(failCount);

			let headline = '等待输入';
			let description = '当前阶段、实时统计。';
			let meta = '结果、落地 IP 和地图会在这里按检测进度逐步展开。';
			let pillText = 'Idle';

			const controls = document.getElementById('resultsControls');

			if (appState === 'resolving') {
				headline = '正在解析目标';
				description = '已接收 ' + inputCount + ' 条输入，正在展开为可检测地址。';
				meta = '解析阶段进行中，准备把输入转换为候选目标。';
				pillText = 'Resolving';
				if (controls) controls.style.display = 'none';
			} else if (appState === 'running') {
				headline = '正在检测 ' + totalTargets + ' 个目标';
				description = '已完成 ' + completedCount + ' 个，当前有效 ' + successCount + ' 个。';
				meta = completedCount + ' / ' + totalTargets + ' 已完成，结果会持续追加。';
				pillText = 'Running';
				if (controls) controls.style.display = 'flex';
			} else if (appState === 'done') {
				headline = '检测完成';
				description = '有效 ' + successCount + ' / ' + totalTargets + '，失败 ' + failCount + '。';
				meta = '本轮检测已结束，点击落地 IP 可展开地图详情。';
				pillText = 'Completed';
				if (controls) controls.style.display = 'flex';
			} else if (appState === 'empty') {
				headline = '未解析到可检测目标';
				description = '请检查域名、IP 或端口格式后重新尝试。';
				meta = '这次输入没有得到有效候选目标。';
				pillText = 'Empty';
				if (controls) controls.style.display = 'none';
			} else if (appState === 'error') {
				headline = '检测过程中出现错误';
				description = '请求被中断或远端接口异常，可以稍后再试。';
				meta = '运行中断，结果可能不完整。';
				pillText = 'Error';
				if (controls) controls.style.display = 'none';
			} else {
				if (controls) controls.style.display = 'none';
			}

			summaryHeadline.innerText = headline;
			summaryDescription.innerText = description;
			resultMeta.innerText = meta;
			resultPill.innerText = pillText;
			resultPill.className = 'results-pill state-' + appState;
		}

		let resultIndex = 0;
		function updateProgress() {
			const percent = totalTargets > 0 ? Math.round((completedCount / totalTargets) * 100) : 0;
			progressBar.style.width = percent + '%';
			progressText.innerText = completedCount + ' / ' + totalTargets;
			renderDashboard();
		}

		function createInputControl(isBatch, value) {
			let control;

			if (isBatch) {
				control = document.createElement('textarea');
				control.placeholder = '每行一个目标，例如：\\n8.223.63.150\\n[2606:4700::]:443\\nProxyIP.CMLiussss.net';
			} else {
				control = document.createElement('input');
				control.type = 'text';
				control.placeholder = '例如：ProxyIP.CMLiussss.net 或 8.223.63.150:443';
			}

			control.id = 'inputList';
			control.className = 'input-control';
			control.value = isBatch ? normalizeBatchInputValue(value || '') : (value || '');
			return control;
		}

		function swapInputMode(isBatch) {
			const currentValue = inputList.value;
			const nextValue = isBatch ? currentValue : currentValue.split('\\n')[0];
			const nextControl = createInputControl(isBatch, nextValue);

			inputContainer.innerHTML = '';
			inputContainer.appendChild(nextControl);

			inputList = nextControl;
			setModeVisuals(isBatch);
			bindInputShortcut();
		}

		function formatLatency(value) {
			if (value === undefined || value === null || value === '') {
				return '延迟未知';
			}
			const text = String(value);
			return text.includes('ms') ? text : text + ' ms';
		}

		function joinUniqueValues(values, fallback) {
			const uniqueValues = Array.from(new Set(values.filter(Boolean)));
			return uniqueValues.length ? uniqueValues.join(' / ') : fallback;
		}

		function getCountryNameInChinese(isoCode) {
			const code = String(isoCode || '').trim().toUpperCase();
			const map = {
				'US': '美国', 'HK': '香港', 'TW': '台湾', 'JP': '日本',
				'SG': '新加坡', 'KR': '韩国', 'GB': '英国', 'FR': '法国',
				'DE': '德国', 'CN': '中国', 'RU': '俄罗斯', 'CA': '加拿大',
				'AU': '澳大利亚', 'NL': '荷兰', 'FI': '芬兰', 'SE': '瑞典',
				'CH': '瑞士', 'IT': '意大利', 'ES': '西班牙', 'BR': '巴西',
				'IN': '印度', 'TR': '土耳其', 'UA': '乌克兰', 'MY': '马来西亚',
				'TH': '泰国', 'VN': '越南', 'ID': '印尼', 'PH': '菲律宾',
				'AE': '阿联酋', 'ZA': '南非', 'AR': '阿根廷', 'MX': '墨西哥',
				'PL': '波兰', 'PT': '葡萄牙', 'GR': '希腊', 'AT': '奥地利',
				'BE': '比利时', 'DK': '丹麦', 'NO': '挪威', 'NZ': '新西兰',
				'IE': '爱尔兰', 'IL': '以色列', 'CL': '智利', 'CO': '哥伦比亚',
				'PE': '秘鲁', 'RO': '罗马尼亚', 'CZ': '捷克', 'HU': '匈牙利',
				'KZ': '哈萨克斯坦', 'KH': '柬埔寨', 'LA': '老挝', 'MM': '缅甸',
				'EG': '埃及', 'NG': '尼日利亚', 'KE': '肯尼亚', 'MA': '摩洛哥',
				'DZ': '阿尔及利亚', 'ET': '埃塞俄比亚', 'PK': '巴基斯坦', 'SA': '沙特阿拉伯',
				'BD': '孟加拉国', 'LK': '斯里兰卡', 'NP': '尼泊尔', 'MN': '蒙古',
				'IS': '冰岛', 'LU': '卢森堡', 'EE': '爱沙尼亚', 'LV': '拉脱维亚',
				'LT': '立陶宛', 'BG': '保加利亚', 'RS': '塞尔维亚', 'HR': '克罗地亚',
				'SI': '斯洛文尼亚', 'SK': '斯洛伐克', 'VE': '委内瑞拉', 'UY': '乌拉圭',
				'PY': '巴拉圭', 'EC': '厄瓜多尔', 'JO': '约旦', 'LB': '黎巴嫩',
				'QA': '卡塔尔', 'KW': '科威特', 'OM': '阿曼', 'BH': '巴林'
			};
			return map[code] || code;
		}

		function getCityNameInChinese(cityName) {
			const city = String(cityName || '').trim();
			const map = {
				// --- 美国 (USA) ---
				'Los Angeles': '洛杉矶', 'San Jose': '圣何塞', 'Seattle': '西雅图',
				'Miami': '迈阿密', 'Dallas': '达拉斯', 'New York': '纽约',
				'New York City': '纽约', 'San Francisco': '旧金山', 'Chicago': '芝加哥',
				'Atlanta': '亚特兰大', 'Washington': '华盛顿', 'Boston': '波士顿',
				'Houston': '休斯顿', 'Phoenix': '菲尼克斯', 'Denver': '丹佛',
				'Las Vegas': '拉斯维加斯', 'Salt Lake City': '盐湖城', 'Portland': '波特兰',
				'Fremont': '弗里蒙特', 'Santa Clara': '圣克拉拉', 'Milpitas': '米尔皮塔斯',
				'Secaucus': '塞考克斯', 'Clifton': '克利夫顿', 'Buffalo': '布法罗',
				'Ashburn': '阿什本', 'Reston': '雷斯顿', 'Philadelphia': '费城',
				'Piscataway': '皮斯卡塔韦', 'Manassas': '马纳萨斯', 'Hillsboro': '希尔斯伯勒',
				'Irvine': '尔湾', 'Honolulu': '檀香山', 'San Diego': '圣地亚哥',
				'Charlotte': '夏洛特', 'Austin': '奥斯汀', 'Nashville': '纳什维尔',
				'Kansas City': '堪萨斯城', 'Orlando': '奥兰多', 'Tampa': '坦帕',
				'Minneapolis': '明尼阿波利斯', 'Detroit': '底特律', 'Columbus': '哥伦布',
				'Indianapolis': '印第安纳波利斯', 'Memphis': '孟斐斯', 'Newark': '纽瓦克',
				'Jersey City': '泽西城', 'Richmond': '里士满', 'Salt Lake': '盐湖城',
				'Durham': '德勒姆', 'Raleigh': '罗利', 'Fairfax': '费尔法克斯',
				'Sterling': '斯特林', 'Herndon': '赫恩登', 'Chantilly': '尚蒂伊',
				'Wilmington': '威尔明顿', 'Tacoma': '塔科马', 'Spokane': '斯波坎',
				'San Antonio': '圣安东尼奥', 'Sacramento': '萨克拉门托', 'Oklahoma City': '俄克拉何马城',
				'St. Louis': '圣路易斯', 'Milwaukee': '密尔沃基', 'Pittsburgh': '匹兹堡',
				'Louisville': '路易斯维尔', 'Baltimore': '巴尔的摩', 'Albuquerque': '阿尔伯克基',
				'Tucson': '图森', 'Omaha': '奥马哈', 'Boise': '博伊西',
				// --- 中国及亚洲 (Asia & China) ---
				'Hong Kong': '香港', 'Tokyo': '东京', 'Osaka': '大阪',
				'Singapore': '新加坡', 'Seoul': '首尔', 'Taipei': '台北',
				'Bangkok': '曼谷', 'Kuala Lumpur': '吉隆坡', 'Ho Chi Minh City': '胡志明市',
				'Manila': '马尼拉', 'Jakarta': '雅加达', 'Phnom Penh': '金边',
				'Vientiane': '万象', 'Yangon': '仰光', 'Mumbai': '孟买',
				'New Delhi': '新德里', 'Chennai': '金奈', 'Dubai': '迪拜',
				'Beijing': '北京', 'Shanghai': '上海', 'Guangzhou': '广州',
				'Shenzhen': '深圳', 'Hangzhou': '杭州', 'Chengdu': '成都',
				'Nanjing': '南京', 'Wuhan': '武汉', 'Xian': '西安',
				'Macau': '澳门', 'Incheon': '仁川', 'Busan': '釜山',
				'Nagoya': '名古屋', 'Fukuoka': '福冈', 'Hanoi': '河内',
				'Chiang Mai': '清迈', 'Phuket': '普吉岛', 'Cebu': '宿务',
				'Johor Bahru': '新山', 'Penang': '槟城', 'Colombo': '科伦坡',
				'Kathmandu': '加德满都', 'Riyadh': '利雅得', 'Jeddah': '吉达',
				'Abu Dhabi': '阿布扎比', 'Doha': '多哈', 'Kuwait City': '科威特城',
				'Muscat': '马斯喀特', 'Amman': '安曼', 'Beirut': '贝鲁特',
				'Tel Aviv': '特拉维夫', 'Jerusalem': '耶路撒冷',
				// --- 欧洲 (Europe) ---
				'London': '伦敦', 'Frankfurt': '法兰克福', 'Frankfurt am Main': '法兰克福',
				'Amsterdam': '阿姆斯特丹', 'Paris': '巴黎', 'Madrid': '马德里',
				'Milan': '米兰', 'Milano': '米兰', 'Rome': '罗马', 'Roma': '罗马',
				'Berlin': '柏林', 'Manchester': '曼彻斯特', 'Stockholm': '斯德哥尔摩',
				'Helsinki': '赫尔辛基', 'Oslo': '奥斯陆', 'Copenhagen': '哥本哈根',
				'Vienna': '维也纳', 'Wien': '维也纳', 'Zurich': '苏黎世', 'Zürich': '苏黎世',
				'Geneva': '日内瓦', 'Genève': '日内瓦', 'Warsaw': '华沙', 'Warszawa': '华沙',
				'Prague': '布拉格', 'Praha': '布拉格', 'Budapest': '布达佩斯',
				'Dublin': '都柏林', 'Lisbon': '里斯本', 'Lisboa': '里斯本',
				'Athens': '雅典', 'Athina': '雅典', 'Istanbul': '伊斯坦布尔',
				'Moscow': '莫斯科', 'Moskva': '莫斯科', 'Saint Petersburg': '圣彼得堡',
				'Brussels': '布鲁塞尔', 'Bruxelles': '布鲁塞尔', 'Brussel': '布鲁塞尔',
				'Munich': '慕尼黑', 'München': '慕尼黑', 'Hamburg': '汉堡',
				'Cologne': '科隆', 'Köln': '科隆', 'Dusseldorf': '杜塞尔多夫',
				'Düsseldorf': '杜塞尔多夫', 'Stuttgart': '斯图加特', 'Nuremberg': '纽伦堡',
				'Nürnberg': '纽伦堡', 'Leipzig': '莱比锡', 'Hannover': '汉诺威',
				'Bremen': '不来梅', 'Dresden': '德累斯顿', 'Dortmund': '多特蒙德',
				'Lyon': '里昂', 'Marseille': '马赛', 'Nice': '尼斯', 'Lille': '里尔',
				'Toulouse': '图卢兹', 'Bordeaux': '波尔多', 'Strasbourg': '斯特拉斯堡',
				'Barcelona': '巴塞罗那', 'Valencia': '瓦伦西亚', 'Seville': '塞维利亚',
				'Bilbao': '毕尔巴鄂', 'Zaragoza': '萨拉戈萨', 'Malaga': '马拉加',
				'Turin': '都灵', 'Torino': '都灵', 'Naples': '那不勒斯', 'Napoli': '那不勒斯',
				'Florence': '佛罗伦萨', 'Firenze': '佛罗伦萨', 'Venice': '威尼斯',
				'Venezia': '威尼斯', 'Bologna': '博洛尼亚', 'Genoa': '热那亚', 'Genova': '热那亚',
				'Sofia': '索非亚', 'Bucharest': '布加勒斯特', 'Kyiv': '基辅', 'Kiev': '基辅',
				'Rotterdam': '鹿特丹', 'The Hague': '海牙', "'s-Gravenhage": '海牙',
				'Antwerp': '安特卫普', 'Ghent': '根特', 'Bruges': '布鲁日',
				'Luxembourg': '卢森堡', 'Birmingham': '伯明翰', 'Glasgow': '格拉斯哥',
				'Leeds': '利兹', 'Edinburgh': '爱丁堡', 'Liverpool': '利物浦',
				'Bristol': '布里斯托', 'Sheffield': '谢菲尔德', 'Newcastle': '纽卡斯尔',
				'Krakow': '克拉科夫', 'Kraków': '克拉科夫', 'Wroclaw': '弗罗茨瓦夫',
				'Wrocław': '弗罗茨瓦夫', 'Gdansk': '格但斯克', 'Gdańsk': '格但斯克',
				'Poznan': '波兹南', 'Vilnius': '维尔纽斯', 'Riga': '里加', 'Tallinn': '塔林',
				'Zagreb': '萨格勒布', 'Belgrade': '贝尔格莱德', 'Beograd': '贝尔格莱德',
				'Bratislava': '布拉迪斯拉发', 'Ljubljana': '卢布尔雅那',
				'Sarajevo': '萨拉热窝', 'Skopje': '斯科普里', 'Tirana': '地拉那',
				'Reykjavik': '雷克雅未克', 'Bern': '伯尔尼', 'Basel': '巴塞尔',
				'Lausanne': '洛桑', 'Gothenburg': '哥德堡', 'Malmo': '马尔默', 'Malmö': '马尔默',
				// --- 大洋洲 (Oceania) ---
				'Sydney': '悉尼', 'Melbourne': '墨尔本', 'Brisbane': '布里斯班',
				'Perth': '珀斯', 'Adelaide': '阿德莱德', 'Canberra': '堪培拉',
				'Gold Coast': '黄金海岸', 'Auckland': '奥克兰', 'Wellington': '惠灵顿',
				'Christchurch': '基督城',
				// --- 加拿大 (Canada) ---
				'Toronto': '多伦多', 'Montreal': '蒙特利尔', 'Vancouver': '温哥华',
				'Ottawa': '渥太华', 'Calgary': '卡尔加里', 'Edmonton': '埃德蒙顿',
				'Winnipeg': '温尼伯', 'Quebec City': '魁北克城',
				// --- 拉丁美洲 (Latin America) ---
				'Sao Paulo': '圣保罗', 'São Paulo': '圣保罗', 'Rio de Janeiro': '里约热内卢',
				'Brasilia': '巴西利亚', 'Salvador': '萨尔瓦多', 'Belo Horizonte': '贝洛奥里藏特',
				'Buenos Aires': '布宜诺斯艾利斯', 'Cordoba': '科尔多瓦', 'Rosario': '罗萨里奥',
				'Santiago': '圣地亚哥', 'Mexico City': '墨西哥城', 'Ciudad de Mexico': '墨西哥城',
				'Guadalajara': '瓜达拉哈拉', 'Monterrey': '蒙特雷',
				'Bogota': '波哥大', 'Bogotá': '波哥大', 'Medellin': '麦德林', 'Medellín': '麦德林',
				'Lima': '利马', 'Caracas': '加拉加斯', 'Quito': '基多',
				'Montevideo': '蒙得维的亚', 'Asuncion': '亚松森',
				// --- 非洲 (Africa) ---
				'Johannesburg': '约翰内斯堡', 'Cape Town': '开普敦', 'Durban': '德班',
				'Cairo': '开罗', 'Alexandria': '亚历山大', 'Casablanca': '卡萨布兰卡',
				'Rabat': '拉巴特', 'Nairobi': '内罗毕', 'Lagos': '拉各斯',
				'Abuja': '阿布贾', 'Accra': '阿克拉', 'Dar es Salaam': '达累斯萨拉姆',
				'Tunis': '突尼斯', 'Algiers': '阿尔及尔', 'Addis Ababa': '亚的斯亚贝巴',
				'Dakar': '达喀尔', 'Kampala': '坎帕拉', 'Khartoum': '喀土穆',
				'Luanda': '罗安达', 'Maputo': '马普托'
			};
			return map[city] || city;
		}

		function formatExitLocation(exitData) {
			const isoCode = getExitCountryCode(exitData);
			const country = getCountryNameInChinese(isoCode);
			const city = getCityNameInChinese(exitData?.city);
			return [country, city].filter(Boolean).join(' · ');
		}

		function formatExitNetwork(exitData) {
			const asn = String(exitData?.asn || '').trim();
			const organization = String(exitData?.asOrganization || '').trim();

			if (asn && organization) {
				return 'AS' + asn + ' · ' + organization;
			}

			if (asn) {
				return 'AS' + asn;
			}

			return organization;
		}

		function getExitCountryCode(exitData) {
			const candidates = [
				exitData?.countryCode,
				exitData?.country_code,
				exitData?.countryIsoCode,
				exitData?.country_iso_code,
				exitData?.country
			];

			for (const candidate of candidates) {
				const normalized = String(candidate || '').trim().toLowerCase();
				if (/^[a-z]{2}$/.test(normalized)) {
					return normalized;
				}
			}

			return '';
		}

		function getFlagUrlFromExitIps(exitIps) {
			for (const entry of exitIps) {
				const countryCode = getExitCountryCode(entry.exitData);
				if (countryCode) {
					return 'https://ipdata.co/flags/' + countryCode + '.png';
				}
			}

			return '';
		}

		function updateResultFlag(itemObj, flagUrl) {
			if (!itemObj?.flag) return;

			if (flagUrl) {
				itemObj.el.classList.add('has-flag');
				itemObj.flag.style.backgroundImage = 'url("' + flagUrl + '")';
				return;
			}

			itemObj.el.classList.remove('has-flag');
			itemObj.flag.style.backgroundImage = '';
		}

		function getExitSelectionKey(exitData, fallbackIp) {
			return [
				String(exitData?.ip || fallbackIp || '').trim(),
				String(exitData?.ipType || '').trim().toLowerCase(),
				normalizeColoCode(exitData?.colo),
				String(exitData?.loc || '').trim()
			].join('|');
		}

		function renderExitList(container, exitIps) {
			container.innerHTML = '';

			if (!exitIps.length) {
				const note = document.createElement('span');
				note.className = 'result-detail is-compact';
				note.innerText = '暂无可展示的出口详情';
				container.appendChild(note);
				return;
			}

			const label = document.createElement('span');
			label.className = 'exit-list-label';
			label.innerText = '落地 IP';
			container.appendChild(label);

			exitIps.forEach(function (entry) {
				const btnWrapper = document.createElement('div');
				btnWrapper.style.display = 'inline-flex';
				btnWrapper.style.alignItems = 'center';
				btnWrapper.style.gap = '4px';

				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'exit-ip-btn';
				button.innerText = entry.ip;
				button.dataset.exitKey = getExitSelectionKey(entry.exitData, entry.ip);
				button.addEventListener('click', function () {
					showDetails(button, entry.exitData);
				});

				const copyBtn = document.createElement('button');
				copyBtn.type = 'button';
				copyBtn.className = 'copy-btn';
				copyBtn.title = '复制 IP';
				copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
				copyBtn.addEventListener('click', function(e) {
					e.stopPropagation();
					copyToClipboard(entry.ip);
					const originalColor = copyBtn.style.color;
					copyBtn.style.color = '#34d399';
					setTimeout(() => copyBtn.style.color = originalColor, 1000);
				});

				btnWrapper.appendChild(button);
				btnWrapper.appendChild(copyBtn);
				container.appendChild(btnWrapper);
			});
		}

		function addResultItem(ip) {
			hideEmptyState();
			const div = document.createElement('div');
			div.className = 'result-item';
			div.dataset.latency = '999999';
			div.dataset.ip = ip;
			div.dataset.index = String(resultIndex++);
			div.innerHTML =
				'<div class="result-checkbox-wrapper">' +
					'<input type="checkbox" class="result-checkbox">' +
				'</div>' +
				'<div class="result-main">' +
					'<div class="result-top">' +
						'<div class="result-info">' +
							'<span class="result-label">候选目标</span>' +
							'<span class="result-ip">' + escapeHtml(ip) + '</span>' +
							'<span class="result-detail">已加入检测队列，正在等待返回结果。</span>' +
						'</div>' +
						'<span class="status-badge status-pending">等待中</span>' +
					'</div>' +
					'<div class="result-meta">' +
						buildMetaChip('准备建立检测请求', 'prep') +
					'</div>' +
					'<div class="exit-list"></div>' +
					'<div class="map-container-wrapper"></div>' +
					'<div class="result-footer-tag"></div>' +
				'</div>';

			resultsDiv.appendChild(div);

			return {
				el: div,
				flag: div.querySelector('.result-flag-overlay'),
				info: div.querySelector('.result-info'),
				badge: div.querySelector('.status-badge'),
				meta: div.querySelector('.result-meta'),
				exitList: div.querySelector('.exit-list'),
				mapContainer: div.querySelector('.map-container-wrapper'),
				footerTag: div.querySelector('.result-footer-tag'),
				checkbox: div.querySelector('.result-checkbox')
			};
		}

		async function checkIP(target) {
			const itemObj = addResultItem(target);

			try {
				const response = await fetch('https://api.090227.xyz/check?proxyip=' + encodeURIComponent(target));
				const data = await response.json();
				completedCount++;

				if (data.success) {
					successCount++;
					itemObj.el.className = 'result-item success';
					const rawLatency = data.responseTime || 0;
					const latencyText = formatLatency(rawLatency);
					itemObj.el.dataset.latency = String(rawLatency);
					
					// 延迟分级
					let latencyClass = 'latency-high';
					if (rawLatency < 100) latencyClass = 'latency-low';
					else if (rawLatency < 300) latencyClass = 'latency-mid';
					
					itemObj.badge.className = 'status-badge ' + latencyClass;
					itemObj.badge.innerText = latencyText;

					const exitIps = [];
					if (data.probe_results?.ipv4?.ok && data.probe_results.ipv4.exit) {
						exitIps.push({ ip: data.probe_results.ipv4.exit.ip, exitData: data.probe_results.ipv4.exit });
					}
					if (data.probe_results?.ipv6?.ok && data.probe_results.ipv6.exit) {
						exitIps.push({ ip: data.probe_results.ipv6.exit.ip, exitData: data.probe_results.ipv6.exit });
					}

					const locations = joinUniqueValues(exitIps.map(function (entry) {
						return formatExitLocation(entry.exitData);
					}), '地区未知');
					const networks = joinUniqueValues(exitIps.map(function (entry) {
						return formatExitNetwork(entry.exitData);
					}), 'ASN / 运营商未知');
					const flagUrl = getFlagUrlFromExitIps(exitIps);

					updateResultFlag(itemObj, flagUrl);

					// 更新底部标签和国旗（文字在前，国旗在后）
					let footerHtml = '<span class="footer-text">' + escapeHtml(locations) + '</span>';
					if (flagUrl) {
						footerHtml += '<img class="footer-flag" src="' + flagUrl + '" alt="flag">';
					}
					itemObj.footerTag.innerHTML = footerHtml;

					itemObj.info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						'<span class="result-ip">' + escapeHtml(data.candidate || target) + '</span>' +
						'<span class="result-detail">代理验证通过，可继续查看出口位置、网络信息和地图分布。</span>';

					const metaParts = [
						buildMetaChip(locations, 'location'),
						buildMetaChip(networks, 'network'),
						buildMetaChip(exitIps.length + '个出口', 'exits')
					];
					itemObj.meta.innerHTML = metaParts.join('');

					renderExitList(itemObj.exitList, exitIps);
				} else {
					itemObj.el.className = 'result-item error';
					itemObj.el.dataset.latency = '999999';
					updateResultFlag(itemObj, '');
					itemObj.badge.className = 'status-badge status-error';
					itemObj.badge.innerText = '不可用';
					itemObj.info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						'<span class="result-ip">' + escapeHtml(target) + '</span>' +
						'<span class="result-detail">无法通过该代理访问 Cloudflare，请更换目标后重试。</span>';
					itemObj.meta.innerHTML =
						buildMetaChip('检测未通过', 'error', 'meta-chip-danger') +
						buildMetaChip(data.message || '远端返回失败结果', 'info');
					itemObj.exitList.innerHTML = '';
					itemObj.footerTag.innerHTML = '';
				}
			} catch (error) {
				completedCount++;
				itemObj.el.className = 'result-item error';
				itemObj.el.dataset.latency = '999999';
				updateResultFlag(itemObj, '');
				itemObj.badge.className = 'status-badge status-error';
				itemObj.badge.innerText = '失败';
				itemObj.info.innerHTML =
					'<span class="result-label">候选目标</span>' +
					'<span class="result-ip">' + escapeHtml(target) + '</span>' +
					'<span class="result-detail">检测请求执行失败，可能是接口异常或网络中断。</span>';
				itemObj.meta.innerHTML =
					buildMetaChip('请求异常', 'error', 'meta-chip-danger') +
					buildMetaChip('请稍后重试', 'retry');
				itemObj.exitList.innerHTML = '';
				itemObj.footerTag.innerHTML = '';
			}

			updateProgress();
			// 触发当前筛选（如果有的话）
			applyCurrentFilter();
		}

		// 新增：复制到剪贴板函数
		function copyToClipboard(text) {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			document.body.appendChild(textarea);
			textarea.select();
			try {
				document.execCommand('copy');
			} catch (err) {
				console.error('Copy failed', err);
			}
			document.body.removeChild(textarea);
		}

		// 新增：全选逻辑
		let isAllSelected = false;
		document.getElementById('selectAllBtn')?.addEventListener('click', function() {
			isAllSelected = !isAllSelected;
			const checkboxes = document.querySelectorAll('.result-checkbox');
			checkboxes.forEach(cb => {
				if (cb.offsetParent !== null) { // 只选可见的
					cb.checked = isAllSelected;
				}
			});
			this.querySelector('span').innerText = isAllSelected ? '取消全选' : '全选';
		});

		// 新增：复制选中逻辑
		document.getElementById('copySelectedBtn')?.addEventListener('click', function() {
			const selectedIps = [];
			document.querySelectorAll('.result-item').forEach(item => {
				const cb = item.querySelector('.result-checkbox');
				if (cb && cb.checked) {
					selectedIps.push(item.dataset.ip);
				}
			});
			if (selectedIps.length) {
				copyToClipboard(selectedIps.join('\\n'));
				const btn = this;
				const originalText = btn.innerHTML;
				btn.innerText = '已复制 ' + selectedIps.length + ' 个';
				setTimeout(() => btn.innerHTML = originalText, 2000);
			} else {
				alert('请先选择要复制的项目');
			}
		});

		// 新增：排序逻辑（三段式：默认 -> 延迟低到高 -> 延迟高到低）
		let sortState = 0; // 0: 默认, 1: 延迟低到高, 2: 延迟高到低
		document.getElementById('sortBtn')?.addEventListener('click', function() {
			const container = document.getElementById('results');
			const items = Array.from(container.querySelectorAll('.result-item'));
			
			sortState = (sortState + 1) % 3;
			
			if (sortState === 1) {
				// 延迟低到高
				items.sort((a, b) => parseInt(a.dataset.latency) - parseInt(b.dataset.latency));
				this.querySelector('span').innerText = '排序: 延迟低到高';
			} else if (sortState === 2) {
				// 延迟高到低 (失败项 999999 始终放在最后)
				items.sort((a, b) => {
					const latA = parseInt(a.dataset.latency);
					const latB = parseInt(b.dataset.latency);
					if (latA === 999999 && latB === 999999) return 0;
					if (latA === 999999) return 1;
					if (latB === 999999) return -1;
					return latB - latA;
				});
				this.querySelector('span').innerText = '排序: 延迟高到低';
			} else {
				// 默认顺序
				items.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
				this.querySelector('span').innerText = '排序: 默认';
			}
			
			items.forEach(item => container.appendChild(item));
		});

		// 新增：筛选逻辑
		let currentMaxLatency = 999999;
		document.querySelectorAll('.filter-pill').forEach(pill => {
			pill.addEventListener('click', function() {
				document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
				this.classList.add('active');
				currentMaxLatency = parseInt(this.dataset.max);
				applyCurrentFilter(true); // 传入 true 表示需要同步勾选状态
			});
		});

		function applyCurrentFilter(syncSelection = false) {
			document.querySelectorAll('.result-item').forEach(item => {
				const latency = parseInt(item.dataset.latency);
				// 核心修改：如果延迟为 999999 (失败项)，则始终隐藏，不计入筛选范围
				const isVisible = latency < 999999 && latency <= currentMaxLatency;
				item.style.display = isVisible ? 'flex' : 'none';
				
				// 如果点击了筛选按钮，则自动同步勾选状态
				if (syncSelection) {
					const cb = item.querySelector('.result-checkbox');
					if (cb) cb.checked = isVisible;
				}
			});
			
			// 每次筛选后重置“全选”按钮的状态提示
			const selectAllBtn = document.getElementById('selectAllBtn');
			if (selectAllBtn) {
				isAllSelected = false;
				selectAllBtn.querySelector('span').innerText = '全选';
			}
		}

		async function showDetails(button, exitData) {
			const item = button.closest('.result-item');
			const container = item.querySelector('.map-container-wrapper');
			const isOpen = container.style.display === 'block';
			const nextSelectionKey = button.dataset.exitKey || getExitSelectionKey(exitData);
			const isSameSelection = isOpen && container.dataset.activeExitKey === nextSelectionKey;
			const currentToken = ++mapRenderToken;

			document.querySelectorAll('.map-container-wrapper').forEach(function (panel) {
				if (panel !== container) {
					panel.style.display = 'none';
					panel.dataset.activeExitKey = '';
				}
			});
			document.querySelectorAll('.exit-ip-btn.is-active').forEach(function (activeButton) {
				activeButton.classList.remove('is-active');
			});

			if (isSameSelection) {
				container.style.display = 'none';
				container.dataset.activeExitKey = '';
				return;
			}

			container.dataset.activeExitKey = nextSelectionKey;
			button.classList.add('is-active');
			initMap();
			container.appendChild(globalMap);
			container.style.display = 'block';

			setTimeout(async function () {
				if (currentToken !== mapRenderToken || container.style.display !== 'block') {
					return;
				}

				map.invalidateSize();

				const exitLocation = parseCoordinatePair(exitData?.loc);
				await loadCfLocations();
				if (currentToken !== mapRenderToken || container.style.display !== 'block') {
					return;
				}

				const cfLocation = getCfLocation(exitData?.colo);
				const cfCoordinates = cfLocation ? [cfLocation.lat, cfLocation.lon] : null;
				const hasExitLocation = isValidCoordinatePair(exitLocation);
				const hasCfLocation = isValidCoordinatePair(cfCoordinates);

				clearMapLayers();

				if (hasExitLocation) {
					const exitMarker = L.circleMarker(exitLocation, {
						radius: 8,
						weight: 2,
						color: '#34d399',
						fillColor: '#34d399',
						fillOpacity: 0.3
					}).addTo(map);
					exitMarker.bindPopup(createExitPopup(exitData));
					mapLayers.push(exitMarker);
				}

				if (hasCfLocation) {
					const cfMarker = L.circleMarker(cfCoordinates, {
						radius: 8,
						weight: 2,
						color: '#61dbff',
						fillColor: '#61dbff',
						fillOpacity: 0.28
					}).addTo(map);
					cfMarker.bindPopup(createCfPopup(cfLocation));
					mapLayers.push(cfMarker);
				}

				if (hasExitLocation && hasCfLocation) {
					const transitLine = L.polyline([exitLocation, cfCoordinates], {
						color: '#8be9ff',
						weight: 2,
						opacity: 0.85,
						dashArray: '8 6',
						renderer: mapSvgRenderer
					}).addTo(map);
					mapLayers.push(transitLine);
					applyArrowStyleToPolyline(transitLine);
					map.fitBounds([exitLocation, cfCoordinates], {
						padding: [36, 36],
						maxZoom: 6
					});
					return;
				}

				if (hasExitLocation) {
					map.setView(exitLocation, 6);
					return;
				}

				if (hasCfLocation) {
					map.setView(cfCoordinates, 5);
					return;
				}

				map.setView([20, 0], 2);
			}, 100);
		}

		batchMode.addEventListener('change', function () {
			swapInputMode(batchMode.checked);
		});

		if (themeToggle) {
			themeToggle.addEventListener('click', function () {
				const currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
				const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
				try {
					localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
				} catch (error) {
					console.warn('Failed to persist theme preference', error);
				}
				applyTheme(nextTheme, 'stored');
			});
		}

		if (systemThemeQuery.addEventListener) {
			systemThemeQuery.addEventListener('change', function (event) {
				if (getStoredTheme()) return;
				applyTheme(event.matches ? 'dark' : 'light', 'system');
			});
		} else if (systemThemeQuery.addListener) {
			systemThemeQuery.addListener(function (event) {
				if (getStoredTheme()) return;
				applyTheme(event.matches ? 'dark' : 'light', 'system');
			});
		}

		checkBtn.addEventListener('click', async function () {
			const value = batchMode.checked ? normalizeBatchInputValue(inputList.value) : stripTargetLabel(inputList.value);
			if (!value) return;

			const lines = batchMode.checked
				? normalizeBatchInputValue(value).split('\\n').map(function (line) { return line.trim(); }).filter(Boolean)
				: [value];

			inputList.value = batchMode.checked ? lines.join('\\n') : value;

			resultsDiv.innerHTML = '';
			resultIndex = 0;
			progressBar.style.width = '0%';
			progressText.innerText = '正在解析目标...';
			showEmptyState('正在准备检测', '正在解析你输入的目标，请稍候。');

			completedCount = 0;
			successCount = 0;
			totalTargets = 0;
			inputCount = lines.length;

			checkBtn.disabled = true;
			setAppState('resolving');

			try {
				const allResolvedTargets = [];

				for (const line of lines) {
					try {
						const response = await fetch('/resolve?proxyip=' + encodeURIComponent(line));
						const targets = await response.json();
						if (Array.isArray(targets)) {
							allResolvedTargets.push(...targets);
						}
					} catch (error) {
						console.error('Resolve error for', line, error);
					}
				}

				if (allResolvedTargets.length > 0) {
					totalTargets = allResolvedTargets.length;
					setAppState('running');
					updateProgress();

					await Promise.all(allResolvedTargets.map(function (target) {
						return checkIP(target);
					}));

					const failCount = Math.max(totalTargets - successCount, 0);
					progressText.innerText = '总计 ' + totalTargets + ' · 有效 ' + successCount + ' · 失败 ' + failCount;
					setAppState('done');
				} else {
					progressText.innerText = '未解析到目标';
					showEmptyState('没有可检测的候选目标', '请检查输入格式，或确认域名是否存在 A / AAAA 记录。');
					setAppState('empty');
				}
			} catch (error) {
				console.error(error);
				progressText.innerText = '系统错误';
				showEmptyState('检测流程中断', '请求过程中发生异常，请稍后重试。');
				setAppState('error');
			} finally {
				checkBtn.disabled = false;
			}
		});

		// ===== 内置反代域名选择器 =====
		const PRESET_DOMAINS = [
		    'proxy.xxxxxxxx.tk:50001',
			'proxyip.cmliussss.net',
            'ProxyIP.HK.CMLiussss.net',
            'ProxyIP.SG.CMLiussss.net',			
            'ProxyIP.JP.CMLiussss.net',
			'ProxyIP.Oracle.cmliussss.net',  
			'ProxyIP.Multacom.CMLiussss.net', 
			'ProxyIP.Vultr.CMLiussss.net',
			'ProxyIP.US.CMLiussss.net',
			'proxyip.wangqifei.eu.org',   
			'sjc.o00o.ooo',  
			'bpb.yousef.isegaro.com',
			'nima.nscl.ir',
			'turk.radicalization.ir',
			'proxyip.oracle.fxxk.dedyn.io',
			'proxyip.aliyun.hw.090227.xyz',
			'proxyip.vultr.fxxk.dedyn.io',
			'proxyip.digitalocean.hw.090227.xyz',
			'proxy.xinyitang.dpdns.org',
			'proxyip.fxxk.dedyn.io'
		];

		(function initPreset() {
			const inputBody = document.getElementById('inputBody');
			const presetToggleBtn = document.getElementById('presetToggleBtn');
			const presetDropdown = document.getElementById('presetDropdown');
			const presetList = document.getElementById('presetList');
			const presetSelectAll = document.getElementById('presetSelectAll');

			if (!inputBody || !presetList) return;

			// 清空输入框逻辑
			const clearInputBtn = document.getElementById('clearInputBtn');
			if (clearInputBtn) {
				clearInputBtn.addEventListener('click', function() {
					inputList.value = '';
					inputList.focus();
				});
			}

			// 从输入框当前内容同步勾选状态到列表
			function syncCheckboxesFromInput() {
				const current = inputList.value.trim();
				const existing = current ? current.split('\\n').map(function (l) { return l.trim(); }).filter(Boolean) : [];
				presetList.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
					cb.checked = existing.includes(cb.value);
				});
				const allChecked = Array.from(presetList.querySelectorAll('input[type="checkbox"]')).every(function (c) { return c.checked; });
				presetSelectAll.checked = allChecked;
				presetSelectAll.indeterminate = !allChecked && Array.from(presetList.querySelectorAll('input[type="checkbox"]')).some(function (c) { return c.checked; });
			}

			// 根据所有勾选状态重建输入框内容
			function syncInputFromCheckboxes() {
				const checked = Array.from(presetList.querySelectorAll('input[type="checkbox"]:checked')).map(function (cb) { return cb.value; });
				// 保留输入框中非预设的自定义内容
				const current = inputList.value.trim();
				const existing = current ? current.split('\\n').map(function (l) { return l.trim(); }).filter(Boolean) : [];
				const customLines = existing.filter(function (line) { return !PRESET_DOMAINS.includes(line); });
				const merged = Array.from(new Set(customLines.concat(checked)));
				inputList.value = merged.join('\\n');

				// 如果有内容且不是批量模式则自动切换
				if (merged.length > 1 && !batchMode.checked) {
					batchMode.checked = true;
					swapInputMode(true);
				}
			}

			// 渲染列表
			PRESET_DOMAINS.forEach(function (domain) {
				const item = document.createElement('label');
				item.className = 'preset-item';
				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.value = domain;
				const lbl = document.createElement('span');
				lbl.className = 'preset-item-label';
				lbl.innerText = domain;
				item.appendChild(cb);
				item.appendChild(lbl);
				presetList.appendChild(item);

				// 勾选即生效：直接同步到输入框
				cb.addEventListener('change', function () {
					syncInputFromCheckboxes();
					const allChecked = Array.from(presetList.querySelectorAll('input[type="checkbox"]')).every(function (c) { return c.checked; });
					presetSelectAll.checked = allChecked;
					presetSelectAll.indeterminate = !allChecked && Array.from(presetList.querySelectorAll('input[type="checkbox"]')).some(function (c) { return c.checked; });
				});
			});

			// 全选
			presetSelectAll.addEventListener('change', function () {
				presetList.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
					cb.checked = presetSelectAll.checked;
				});
				presetSelectAll.indeterminate = false;
				syncInputFromCheckboxes();
			});

			// 展开/收起时同步勾选状态
			presetToggleBtn.addEventListener('click', function (e) {
				const willOpen = !inputBody.classList.contains('is-open');
				inputBody.classList.toggle('is-open');
				if (willOpen) {
					syncCheckboxesFromInput();
				}
				e.stopPropagation();
			});

			// 点击外部关闭
			document.addEventListener('click', function (e) {
				if (!presetDropdown.contains(e.target) && !presetToggleBtn.contains(e.target)) {
					inputBody.classList.remove('is-open');
				}
			});
		})();

		// ===== Finder 功能逻辑 =====
		const proxyRegionSelect = document.getElementById('proxyRegionSelect');
		const proxyPortSelect = document.getElementById('proxyPortSelect');
		const customRegionField = document.getElementById('customRegionField');
		const customRegionInput = document.getElementById('customRegionInput');
		const fofaBtn = document.getElementById('fofaBtn');

		function normalizeCustomRegionCode(value) {
			return String(value || '').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase();
		}

		function updateCustomRegionField(shouldFocus) {
			if (!proxyRegionSelect || !customRegionField || !customRegionInput) return;
			const isCustom = proxyRegionSelect.value === 'custom';
			const selectedRegion = /^[A-Z]{2}$/.test(proxyRegionSelect.value) ? proxyRegionSelect.value : '';
			customRegionInput.disabled = !isCustom;
			customRegionInput.required = isCustom;
			customRegionInput.placeholder = isCustom ? 'US' : '';
			if (isCustom) {
				customRegionInput.value = normalizeCustomRegionCode(customRegionInput.value);
				if (shouldFocus) setTimeout(() => customRegionInput.focus(), 0);
			} else {
				customRegionInput.value = selectedRegion;
			}
		}

		function getSelectedFOFARegion() {
			if (!proxyRegionSelect) return '';
			if (proxyRegionSelect.value === 'custom') {
				const region = normalizeCustomRegionCode(customRegionInput ? customRegionInput.value : '');
				if (customRegionInput) customRegionInput.value = region;
				if (!/^[A-Z]{2}$/.test(region)) {
					showToast('请输入有效的两位国家代码', 'error');
					return null;
				}
				return region;
			}
			return /^[A-Z]{2}$/.test(proxyRegionSelect.value) ? proxyRegionSelect.value : '';
		}

		function openFOFA() {
			const region = getSelectedFOFARegion();
			const port = proxyPortSelect ? proxyPortSelect.value : '';
			if (region === null) return;
			if (!region) { showToast('请选择有效地区', 'error'); return; }
			let regionQuery = (region === 'HK' || region === 'TW' || region === 'MO') ? 'region="' + region + '"' : 'country="' + region + '"';
			let portQuery = port === '443' ? 'port="443"' : '(port!="80" && port!="8080" && port!="8880" && port!="2052" && port!="2082" && port!="2086" && port!="2095" && port!="443" && port!="2053" && port!="2083" && port!="2087" && port!="2096" && port!="8443")';
			const query = 'server=="cloudflare" && header="Forbidden" && asn!="13335" && asn!="209242" && ' + regionQuery + ' && ' + portQuery;
			window.open('https://fofa.info/result?qbase64=' + btoa(query), '_blank', 'noopener');
		}

		if (proxyRegionSelect) {
			proxyRegionSelect.addEventListener('change', () => updateCustomRegionField(true));
			updateCustomRegionField(false);
		}
		if (fofaBtn) fofaBtn.addEventListener('click', openFOFA);

		window.onload = function () {
			setModeVisuals(true);
			swapInputMode(true);
			bindInputShortcut();
			renderDashboard();
			loadCfLocations();
			fetchVisitCount();

			const path = window.location.pathname.slice(1);
			if (path && path.length > 3) {
				const decodedPath = decodeURIComponent(path);
				if (decodedPath !== 'resolve' && decodedPath !== 'favicon.ico') {
					inputList.value = decodedPath;
					window.history.replaceState({}, '', '/');
					checkBtn.click();
				}
			}
		};
	</script>
</body>
</html>`;
}
