import { SafeAreaView, View, Text, Button, StyleSheet } from 'react-native'
import { useEffect, useState } from 'react'
import { BarCodeScanner } from 'expo-barcode-scanner'

export default function App() {
  const [mode, setMode] = useState<'home' | 'scanner'>('home')
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [scannedText, setScannedText] = useState<string>('')

  useEffect(() => {
    if (mode === 'scanner') {
      ;(async () => {
        const { status } = await BarCodeScanner.requestPermissionsAsync()
        setHasPermission(status === 'granted')
      })()
    }
  }, [mode])

  function handleScan({ type, data }: { type: string; data: string }) {
    setScannedText(data)
    setMode('home')
  }

  if (mode === 'scanner') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.scannerHeader}>
          <Text style={styles.title}>Scan QR</Text>
          <Button title="Close" onPress={() => setMode('home')} />
        </View>
        {hasPermission === null ? (
          <View style={styles.center}><Text>Requesting camera permission…</Text></View>
        ) : hasPermission === false ? (
          <View style={styles.center}><Text>No access to camera</Text></View>
        ) : (
          <BarCodeScanner
            onBarCodeScanned={handleScan}
            style={styles.scanner}
          />
        )}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>BillBox Mobile 🚀</Text>
        <Button title="Open QR Scanner" onPress={() => setMode('scanner')} />
        {scannedText ? (
          <View style={{ marginTop: 16, paddingHorizontal: 24 }}>
            <Text style={{ fontSize: 12, color: '#666' }}>Last scanned:</Text>
            <Text selectable>{scannedText}</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scannerHeader: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scanner: { flex: 1 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
})
