import React, { useEffect, useState } from 'react'
import { Alert, Button, FlatList, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Auth, BillsApi, BillsTypes, WarrantiesApi, WarrantiesTypes, parsePaymentQR } from '@billbox/shared'

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <View style={styles.container}>
      <Text style={styles.title}>BillBox</Text>
      <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <TouchableOpacity disabled={busy} style={styles.primaryBtn} onPress={async () => {
        setBusy(true)
        const { error } = await Auth.signIn(email, password)
        setBusy(false)
        if (error) Alert.alert('Login failed', error instanceof Error ? error.message : String(error))
        else onLoggedIn()
      }}>
        <Text style={styles.primaryBtnText}>{busy ? 'Signing in…' : 'Sign In'}</Text>
      </TouchableOpacity>
    </View>
  )
}

function BillsScreen() {
  const [items, setItems] = useState<BillsTypes.Bill[]>([])
  const [supplier, setSupplier] = useState('')
  const [amount, setAmount] = useState('')
  useEffect(() => { (async () => { const { data } = await BillsApi.listBills(); setItems(data) })() }, [])
  async function add() {
    const amt = Number(amount)
    if (!supplier || Number.isNaN(amt)) { Alert.alert('Validation', 'Enter supplier and amount'); return }
    const { data, error } = await BillsApi.createBill({ supplier, amount: amt, currency: 'EUR', due_date: new Date().toISOString().slice(0,10) })
    if (error) { Alert.alert('Error', String(error.message)); return }
    if (data) setItems((prev) => [data, ...prev])
    setSupplier(''); setAmount('')
  }
  async function del(id: string) {
    Alert.alert('Are you sure?', 'Delete bill permanently?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const { error } = await BillsApi.deleteBill(id); if (error) Alert.alert('Error', String(error.message)); setItems((prev)=>prev.filter(b=>b.id!==id)) } }
    ])
  }
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Bills</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input, { flex: 1 }]} placeholder="Supplier" value={supplier} onChangeText={setSupplier} />
        <TextInput style={[styles.input, { width: 100 }]} placeholder="Amount" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
        <Button title="Add" onPress={add} />
      </View>
      <FlatList data={items} keyExtractor={(b)=>b.id} renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.supplier}</Text>
          <Text>{item.currency} {item.amount} due {item.due_date}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button title="Mark Paid" onPress={async ()=>{ const { data } = await BillsApi.setBillStatus(item.id, 'paid'); if (data) setItems(prev=>prev.map(b=>b.id===item.id?data:b)) }} />
            <Button title="Delete" color="#c00" onPress={()=>del(item.id)} />
          </View>
        </View>
      )} />
    </View>
  )
}

function WarrantiesScreen() {
  const [items, setItems] = useState<WarrantiesTypes.Warranty[]>([])
  const [name, setName] = useState('')
  useEffect(() => { (async () => { const { data } = await WarrantiesApi.listWarranties(); setItems(data) })() }, [])
  async function add() {
    if (!name) { Alert.alert('Validation', 'Enter item name'); return }
    const { data, error } = await WarrantiesApi.createWarranty({ item_name: name })
    if (error) { Alert.alert('Error', String(error.message)); return }
    if (data) setItems((prev) => [data, ...prev])
    setName('')
  }
  async function del(id: string) {
    Alert.alert('Are you sure?', 'Delete warranty permanently?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const { error } = await WarrantiesApi.deleteWarranty(id); if (error) Alert.alert('Error', String(error.message)); setItems((prev)=>prev.filter(w=>w.id!==id)) } }
    ])
  }
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Warranties</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input, { flex: 1 }]} placeholder="Item name" value={name} onChangeText={setName} />
        <Button title="Add" onPress={add} />
      </View>
      <FlatList data={items} keyExtractor={(w)=>w.id} renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.item_name}</Text>
          <Text>{item.supplier || ''}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button title="Delete" color="#c00" onPress={()=>del(item.id)} />
          </View>
        </View>
      )} />
    </View>
  )
}

function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions()
  const [torch, setTorch] = useState<'on' | 'off'>('off')
  const [lastQR, setLastQR] = useState<string>('')
  useEffect(() => { (async ()=>{ if (!permission?.granted) await requestPermission() })() }, [permission])
  return (
    <View style={{ flex: 1 }}>
      <CameraView style={{ flex: 1 }} facing={'back'} enableTorch={torch==='on'} onBarcodeScanned={(evt)=>{
        const text = (evt?.data ?? '').toString()
        if (!text || text===lastQR) return
        setLastQR(text)
        const res = parsePaymentQR(text)
        if (!res) { Alert.alert('No EPC/UPN data detected'); return }
        Alert.alert('Parsed Payment', JSON.stringify(res, null, 2))
      }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} />
      <View style={{ position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center' }}>
        <TouchableOpacity style={styles.secondaryBtn} onPress={()=> setTorch(t => t==='on'? 'off':'on') }>
          <Text style={styles.secondaryBtnText}>{torch==='on' ? 'Torch Off' : 'Torch On'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

type Tab = 'bills' | 'warranties' | 'scan' | 'reports'

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [tab, setTab] = useState<Tab>('bills')
  useEffect(() => { (async ()=>{ const { data } = await Auth.getSession(); setLoggedIn(!!data?.session) })() }, [])
  if (!loggedIn) return <LoginScreen onLoggedIn={()=>setLoggedIn(true)} />
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.navbar}>
        {(['bills','warranties','scan','reports'] as Tab[]).map((t)=> (
          <TouchableOpacity key={t} style={[styles.navItem, tab===t && styles.navItemActive]} onPress={()=>setTab(t)}>
            <Text style={[styles.navItemText, tab===t && styles.navItemTextActive]}>{t.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab==='bills' && <BillsScreen />}
      {tab==='warranties' && <WarrantiesScreen />}
      {tab==='scan' && <ScanScreen />}
      {tab==='reports' && (
        <View style={styles.container}><Text style={styles.sectionTitle}>Payments / Reports</Text><Text>Basic overview placeholder</Text></View>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '600', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  primaryBtn: { backgroundColor: '#2b6cb0', paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  secondaryBtn: { backgroundColor: '#00000088', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20 },
  secondaryBtnText: { color: '#fff' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  navbar: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#eee' },
  navItem: { flex: 1, padding: 12, alignItems: 'center' },
  navItemActive: { borderBottomWidth: 2, borderColor: '#2b6cb0' },
  navItemText: { color: '#666' },
  navItemTextActive: { color: '#2b6cb0', fontWeight: '600' }
})
