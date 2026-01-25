import React, { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { registerRootComponent } from 'expo'

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
function Bootstrap() {
	const [AppComponent, setAppComponent] = useState<React.ComponentType | null>(null)
	const [error, setError] = useState<Error | null>(null)

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
		}
	}, [])

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

registerRootComponent(Bootstrap)