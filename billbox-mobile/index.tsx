import React, { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { registerRootComponent } from 'expo'
import Constants from 'expo-constants'
import * as Sentry from '@sentry/react-native'

const sentryDsn =
	process.env.EXPO_PUBLIC_SENTRY_DSN ||
	(Constants as any)?.expoConfig?.extra?.sentryDsn ||
	(Constants as any)?.manifest2?.extra?.sentryDsn ||
	''

if (sentryDsn) {
	Sentry.init({
		dsn: sentryDsn,
		debug: false,
	})
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
function Bootstrap() {
	const [AppComponent, setAppComponent] = useState<React.ComponentType | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const [didSendInit, setDidSendInit] = useState(false)

	useEffect(() => {
		try {
			// Lazy-require App to catch module init errors.
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const mod = require('./App')
			const Component = mod?.default || mod
			setAppComponent(() => Component)
		} catch (err: any) {
			const e = err instanceof Error ? err : new Error(String(err))
			setError(e)
			try {
				Sentry.captureException(e)
			} catch {}
		}
	}, [])

	useEffect(() => {
		if (!sentryDsn || didSendInit) return
		// Send a lightweight "app_init" event only after the JS app has actually mounted.
		try {
			Sentry.captureMessage('app_init')
		} catch {}
		setDidSendInit(true)
	}, [didSendInit])

	if (error) {
		return (
			<ScrollView contentContainerStyle={{ padding: 24 }}>
				<Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 12 }}>App failed to start</Text>
				<Text selectable style={{ fontSize: 12, color: '#111827' }}>{String(error?.message || error)}</Text>
				{error?.stack ? (
					<Text selectable style={{ fontSize: 12, color: '#6B7280', marginTop: 12 }}>{error.stack}</Text>
				) : null}
			</ScrollView>
		)
	}

	if (!AppComponent) {
		return (
			<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
				<Text>Loading…</Text>
			</View>
		)
	}

	return <AppComponent />
}

const Root = sentryDsn ? Sentry.wrap(Bootstrap) : Bootstrap
registerRootComponent(Root)