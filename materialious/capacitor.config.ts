import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'us.materialio.app.livefork',
	appName: 'Materialious Live',
	webDir: 'build',
	plugins: {
		CapacitorNodeJS: {
			nodeDir: 'nodejsAndroid'
		}
	},
	server: {
		hostname: 'www.youtube.com',
		androidScheme: 'https'
	}
};

export default config;
