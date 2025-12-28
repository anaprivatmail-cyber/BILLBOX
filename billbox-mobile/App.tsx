import React from 'react'
import { SafeAreaView, View, Text, Button, StyleSheet } from 'react-native'

export default function App() {
  const openQrScanner = () => {
    // Placeholder: navigate to scanner screen in future
    console.log('[Mobile] Open QR Scanner pressed')
  }

  return (
    <SafeAreaView style={styles.safe}> 
      <View style={styles.container}>
        <Text style={styles.title}>BillBox Mobile 🚀</Text>
        <Button title="Open QR Scanner" onPress={openQrScanner} />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
})
