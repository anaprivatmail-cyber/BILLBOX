import { registerRootComponent } from 'expo'
import Constants from 'expo-constants'
import * as Sentry from 'sentry-expo'

import App from './App'

const sentryDsn =
	process.env.EXPO_PUBLIC_SENTRY_DSN ||
	(Constants as any)?.expoConfig?.extra?.sentryDsn ||
	(Constants as any)?.manifest2?.extra?.sentryDsn ||
	''

if (sentryDsn) {
	Sentry.init({
		dsn: sentryDsn,
		enableInExpoDevelopment: true,
		debug: false,
	})
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Sentry.wrap(App))
