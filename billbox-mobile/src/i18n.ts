import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Localization from 'expo-localization'

import { phraseDict } from './i18n.phrases'

export type Lang = 'sl' | 'en' | 'hr' | 'it' | 'de'

const LS_LANG = 'billbox.lang'

let currentLang: Lang = 'en'

export function getCurrentLang(): Lang {
  return currentLang
}

export function setCurrentLang(lang: Lang): void {
  currentLang = lang
}

type Dict = Record<string, string>

type DictByLang = Record<Lang, Dict>

const dict: DictByLang = {
  en: {
    app_title: 'BillBox',
    login_tagline: 'Keep bills and warranties in one place.',

    checking_session: 'Checking session…',

    // Auth
    email_placeholder: 'Email',
    password_placeholder: 'Password',
    confirm_password_placeholder: 'Confirm password',

    sign_in: 'Sign in',
    sign_up: 'Create account',
    reset_password: 'Reset password',

    continue_as_email: 'Continue as {email}',

    error_generic: 'Something went wrong. Please try again.',
    error_email_password_required: 'Email and password are required.',
    error_email_required: 'Email is required.',
    error_fill_required: 'Please fill in all required fields.',
    error_password_mismatch: 'Passwords do not match.',

    auth_requires_cloud: 'This action requires cloud mode (Supabase).',
    auth_offline_hint: 'You are in offline mode. You can still use the app locally.',

    sign_up_success_check_email: 'Account created. Please check your email to confirm.',
    reset_password_success: 'Password reset email sent.',
    confirmation_email_sent: 'Confirmation email sent.',

    social_not_configured: 'Social sign-in is not configured for this build.',
    google_sign_in: 'Continue with Google',
    apple_sign_in: 'Continue with Apple',

    forgot_password: 'Forgot password?',
    resend_confirmation: 'Resend confirmation email',
    create_account_prompt: 'Create an account',
    back_to_sign_in: 'Back to sign in',

    continue_without_login: 'Continue without login',
    offline_mode: 'Offline mode',

    language: 'Language',
    slovenian: 'Slovenian',
    english: 'English',
    croatian: 'Croatian',
    italian: 'Italian',
    german: 'German',

    // Screen names (used lightly)
    home: 'Home',
    scan: 'Scan',
    bills: 'Bills',
    pay: 'Pay',
    settings: 'Settings',

    Profiles: 'Profiles',

    Free: 'Free',

    Moje: 'Moje',
    'Več': 'Več',

    'Subscription plans': 'Subscription plans',
    'Your plan': 'Your plan',
    'Save €{amount} with yearly billing': 'Save €{amount} with yearly billing',
    'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}':
      'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}',
    'Yearly (save €{amount})': 'Yearly (save €{amount})',
    'OCR helps extract data from photos/PDFs. Limits reset monthly.': 'OCR helps extract data from photos/PDFs. Limits reset monthly.',
  },
  sl: {
    app_title: 'BillBox',
    login_tagline: 'Računi in garancije na enem mestu.',
    checking_session: 'Preverjam sejo…',

    email_placeholder: 'E-pošta',
    password_placeholder: 'Geslo',
    confirm_password_placeholder: 'Potrdi geslo',

    sign_in: 'Prijava',
    sign_up: 'Ustvari račun',
    reset_password: 'Ponastavi geslo',

    continue_as_email: 'Nadaljuj kot {email}',

    error_generic: 'Nekaj je šlo narobe. Poskusi znova.',
    error_email_password_required: 'E-pošta in geslo sta obvezna.',
    error_email_required: 'E-pošta je obvezna.',
    error_fill_required: 'Izpolni obvezna polja.',
    error_password_mismatch: 'Gesli se ne ujemata.',

    auth_requires_cloud: 'Za to je potreben cloud način (Supabase).',
    auth_offline_hint: 'Si v offline načinu. Aplikacijo lahko uporabljaš lokalno.',

    sign_up_success_check_email: 'Račun ustvarjen. Preveri e-pošto za potrditev.',
    reset_password_success: 'E-pošta za ponastavitev gesla je poslana.',
    confirmation_email_sent: 'Potrditveni e-mail je poslan.',

    social_not_configured: 'Prijava s ponudnikom ni nastavljena za to verzijo.',
    google_sign_in: 'Nadaljuj z Google',
    apple_sign_in: 'Nadaljuj z Apple',

    forgot_password: 'Pozabljeno geslo?',
    resend_confirmation: 'Ponovno pošlji potrditev',
    create_account_prompt: 'Ustvari račun',
    back_to_sign_in: 'Nazaj na prijavo',

    continue_without_login: 'Nadaljuj brez prijave',
    offline_mode: 'Offline način',

    language: 'Jezik',
    slovenian: 'Slovenščina',
    english: 'Angleščina',
    croatian: 'Hrvaščina',
    italian: 'Italijanščina',
    german: 'Nemščina',

    home: 'Domov',
    scan: 'Skeniraj',
    bills: 'Računi',
    pay: 'Plačilo',
    settings: 'Nastavitve',

    // AI
    'AI assistant': 'AI pomočnik',
    'AI unavailable': 'AI ni na voljo',
    'Missing EXPO_PUBLIC_FUNCTIONS_BASE': 'Manjka EXPO_PUBLIC_FUNCTIONS_BASE',
    'Here are a few helpful next steps.': 'Tukaj je nekaj koristnih naslednjih korakov.',
    'AI request failed.': 'AI zahteva ni uspela.',
    'How can I help? Ask anything, or pick a suggestion.': 'Kako lahko pomagam? Vprašaj karkoli ali izberi predlog.',
    Close: 'Zapri',
    Open: 'Odpri',
    'Thinking…': 'Razmišljam…',
    'Ask a question…': 'Postavi vprašanje…',
    Send: 'Pošlji',
    'Light mode': 'Svetli način',
    'Dark mode': 'Temni način',
    Payments: 'Plačila',

    'Preparing your workspace…': 'Pripravljam delovni prostor…',
    'Preparing payers…': 'Pripravljam profile…',
    'Processing payment…': 'Obdelujem plačilo…',

    // Pay / Payments
    Today: 'Danes',
    'This week': 'Ta teden',
    Later: 'Kasneje',
    '{count} bills': '{count} računov',
    'Current plan': 'Trenutni paket',
    'Your plan': 'Tvoj paket',
    Profiles: 'Profili',
    Moje: 'Moje',
    'Več': 'Več',
    'Save €{amount} with yearly billing': 'Prihrani €{amount} z letnim plačilom',
    'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}':
      'Prihrani z letnim plačilom: {planBasic} prihrani €{basicAmount} • {planPro} prihrani €{proAmount}',
    'Yearly (save €{amount})': 'Letno (prihrani €{amount})',
    'OCR helps extract data from photos/PDFs. Limits reset monthly.': 'OCR pomaga iz slike/PDF-ja izluščiti podatke. Omejitve se ponastavijo mesečno.',
    Payers: 'Profili',
    enabled: 'vklopljeno',
    disabled: 'izklopljeno',
    Exports: 'Izvozi',
    Free: 'Brezplačno',
    Basic: 'Moje',
    Pro: 'Več',
    'Subscription plans': 'Naročniški paketi',
    '€2.20 / month or €20 / year': '€2,20 / mesec ali €20 / leto',
    '€4 / month or €38 / year': '€4 / mesec ali €38 / leto',
    'Basic monthly': 'Moje mesečno',
    'Basic yearly': 'Moje letno',
    'Pro monthly': 'Več mesečno',
    'Pro yearly': 'Več letno',
    'Restore purchases': 'Obnovi nakupe',
    'Purchases unavailable': 'Nakupi niso na voljo',
    'Purchases are available only in the store build.': 'Nakupi so na voljo samo v trgovinski (store) verziji.',
    'Payments not configured': 'Plačila niso nastavljena',
    'Product ID is missing in environment variables.': 'Product ID manjka v okoljskih spremenljivkah.',
    'Subscription updated. Thank you!': 'Naročnina posodobljena. Hvala!',
    'Verification failed': 'Preverjanje ni uspelo',
    'We could not verify your purchase. Please try again later.': 'Nakupa nismo mogli preveriti. Poskusi znova kasneje.',
    'Purchase error': 'Napaka pri nakupu',
    'Something went wrong while processing the purchase.': 'Pri obdelavi nakupa je šlo nekaj narobe.',
    'No purchases': 'Ni nakupov',
    'No previous purchases were found for this account.': 'Za ta račun ni bilo najdenih preteklih nakupov.',
    'Purchases restored. Your plan is up to date.': 'Nakupi obnovljeni. Tvoj paket je posodobljen.',
    'Restore failed': 'Obnova ni uspela',
    'We could not restore your purchases. Please try again later.': 'Nakupov nismo mogli obnoviti. Poskusi znova kasneje.',
    'Restore error': 'Napaka pri obnovi',
    'Something went wrong while restoring purchases.': 'Pri obnovi nakupov je šlo nekaj narobe.',

    // Bills / filters
    Bills: 'Računi',
    'Untitled bill': 'Neimenovan račun',
    attachment: 'priloga',
    attachments: 'priloge',
    'Default space': 'Privzeti prostor',
    'Invoice date': 'Datum računa',
    Created: 'Ustvarjeno',
    'Loading space…': 'Nalaganje prostora…',
    Filters: 'Filtri',
    'Filtering by {field}': 'Filtriram po {field}',
    Due: 'Rok',
    Invoice: 'Račun',
    'Date range': 'Datum od–do',
    'Start date': 'Začetni datum',
    'End date': 'Končni datum',
    'Unpaid only': 'Samo neplačani',
    Overdue: 'Zapadli',
    'Has attachment': 'Ima prilogo',
    'Include archived': 'Vključi arhivirane',
    'Tap "Filters" to adjust date, supplier, amount, status, and attachments.': 'Tapni "Filtri" za datum, dobavitelja, znesek, status in priloge.',
    'Loading bills…': 'Nalaganje računov…',
    'Select date': 'Izberi datum',
    'Cloud sync is disabled. Bills are stored locally until you connect Supabase.': 'Sinhronizacija v oblaku je izklopljena. Računi so shranjeni lokalno, dokler ne povežeš Supabase.',

    'Upgrade required': 'Potrebna je nadgradnja',
  },
  hr: {
    app_title: 'BillBox',
    login_tagline: 'Računi i jamstva na jednom mjestu.',
    checking_session: 'Provjera sesije…',

    email_placeholder: 'Email',
    password_placeholder: 'Lozinka',
    confirm_password_placeholder: 'Potvrdi lozinku',

    sign_in: 'Prijava',
    sign_up: 'Kreiraj račun',
    reset_password: 'Reset lozinke',

    continue_as_email: 'Nastavi kao {email}',

    error_generic: 'Nešto je pošlo po zlu. Pokušaj ponovno.',
    error_email_password_required: 'Email i lozinka su obavezni.',
    error_email_required: 'Email je obavezan.',
    error_fill_required: 'Ispuni obavezna polja.',
    error_password_mismatch: 'Lozinke se ne podudaraju.',

    auth_requires_cloud: 'Ova radnja zahtijeva cloud način (Supabase).',
    auth_offline_hint: 'U offline ste načinu. Možete koristiti aplikaciju lokalno.',

    sign_up_success_check_email: 'Račun kreiran. Provjerite email za potvrdu.',
    reset_password_success: 'Poslan je email za reset lozinke.',
    confirmation_email_sent: 'Poslan je email za potvrdu.',

    social_not_configured: 'Društvena prijava nije podešena za ovu verziju.',
    google_sign_in: 'Nastavi s Google',
    apple_sign_in: 'Nastavi s Apple',

    forgot_password: 'Zaboravljena lozinka?',
    resend_confirmation: 'Ponovno pošalji potvrdu',
    create_account_prompt: 'Kreiraj račun',
    back_to_sign_in: 'Natrag na prijavu',

    continue_without_login: 'Nastavi bez prijave',
    offline_mode: 'Offline način',

    language: 'Jezik',
    slovenian: 'Slovenski',
    english: 'Engleski',
    croatian: 'Hrvatski',
    italian: 'Talijanski',
    german: 'Njemački',

    home: 'Početna',
    scan: 'Skeniraj',
    bills: 'Računi',
    pay: 'Plaćanje',
    settings: 'Postavke',

    // AI
    'AI assistant': 'AI asistent',
    'AI unavailable': 'AI nije dostupan',
    'Missing EXPO_PUBLIC_FUNCTIONS_BASE': 'Nedostaje EXPO_PUBLIC_FUNCTIONS_BASE',
    'Here are a few helpful next steps.': 'Evo nekoliko korisnih sljedećih koraka.',
    'AI request failed.': 'AI zahtjev nije uspio.',
    'How can I help? Ask anything, or pick a suggestion.': 'Kako mogu pomoći? Pitaj bilo što ili odaberi prijedlog.',
    Close: 'Zatvori',
    Open: 'Otvori',
    'Thinking…': 'Razmišljam…',
    'Ask a question…': 'Postavi pitanje…',
    Send: 'Pošalji',
    'Light mode': 'Svijetli način',
    'Dark mode': 'Tamni način',
    Payments: 'Plaćanja',

    'Preparing your workspace…': 'Pripremam radni prostor…',
    'Preparing payers…': 'Pripremam profile…',
    'Processing payment…': 'Obrađujem plaćanje…',

    // Pay / Payments
    Today: 'Danas',
    'This week': 'Ovaj tjedan',
    Later: 'Kasnije',
    '{count} bills': '{count} računa',
    'Current plan': 'Trenutni plan',
    'Your plan': 'Tvoj plan',
    Profiles: 'Profili',
    Moje: 'Moje',
    'Več': 'Več',
    'Save €{amount} with yearly billing': 'Uštedi €{amount} uz godišnje plaćanje',
    'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}':
      'Uštedi uz godišnje plaćanje: {planBasic} uštedi €{basicAmount} • {planPro} uštedi €{proAmount}',
    'Yearly (save €{amount})': 'Godišnje (uštedi €{amount})',
    'OCR helps extract data from photos/PDFs. Limits reset monthly.': 'OCR pomaže izdvojiti podatke iz fotografija/PDF-a. Ograničenja se resetiraju mjesečno.',
    Payers: 'Profili',
    enabled: 'uključeno',
    disabled: 'isključeno',
    Exports: 'Izvozi',
    Free: 'Besplatno',
    Basic: 'Moje',
    Pro: 'Več',
    'Subscription plans': 'Pretplatnički planovi',
    '€2.20 / month or €20 / year': '€2,20 / mjesec ili €20 / godina',
    '€4 / month or €38 / year': '€4 / mjesec ili €38 / godina',
    'Basic monthly': 'Moje mjesečno',
    'Basic yearly': 'Moje godišnje',
    'Pro monthly': 'Več mjesečno',
    'Pro yearly': 'Več godišnje',
    'Restore purchases': 'Vrati kupnje',
    'Purchases unavailable': 'Kupnje nisu dostupne',
    'Purchases are available only in the store build.': 'Kupnje su dostupne samo u store verziji.',
    'Payments not configured': 'Plaćanja nisu konfigurirana',
    'Product ID is missing in environment variables.': 'Product ID nedostaje u varijablama okruženja.',
    'Subscription updated. Thank you!': 'Pretplata ažurirana. Hvala!',
    'Verification failed': 'Provjera nije uspjela',
    'We could not verify your purchase. Please try again later.': 'Nismo mogli provjeriti kupnju. Pokušaj kasnije.',
    'Purchase error': 'Greška pri kupnji',
    'Something went wrong while processing the purchase.': 'Nešto je pošlo po zlu tijekom obrade kupnje.',
    'No purchases': 'Nema kupnji',
    'No previous purchases were found for this account.': 'Nisu pronađene prethodne kupnje za ovaj račun.',
    'Purchases restored. Your plan is up to date.': 'Kupnje vraćene. Tvoj plan je ažuran.',
    'Restore failed': 'Vraćanje nije uspjelo',
    'We could not restore your purchases. Please try again later.': 'Nismo mogli vratiti kupnje. Pokušaj kasnije.',
    'Restore error': 'Greška pri vraćanju',
    'Something went wrong while restoring purchases.': 'Nešto je pošlo po zlu tijekom vraćanja kupnji.',

    // Bills / filters
    Bills: 'Računi',
    'Untitled bill': 'Neimenovani račun',
    attachment: 'prilog',
    attachments: 'prilozi',
    'Default space': 'Zadani prostor',
    'Invoice date': 'Datum računa',
    Created: 'Kreirano',
    'Loading space…': 'Učitavanje prostora…',
    Filters: 'Filteri',
    'Filtering by {field}': 'Filtriranje po {field}',
    Due: 'Rok',
    Invoice: 'Račun',
    'Date range': 'Raspon datuma',
    'Start date': 'Početni datum',
    'End date': 'Završni datum',
    'Unpaid only': 'Samo neplaćeni',
    Overdue: 'Dospjelo',
    'Has attachment': 'Ima prilog',
    'Include archived': 'Uključi arhivirane',
    'Tap "Filters" to adjust date, supplier, amount, status, and attachments.': 'Dodirni "Filteri" za datum, dobavljača, iznos, status i priloge.',
    'Loading bills…': 'Učitavanje računa…',
    'Select date': 'Odaberi datum',
    'Cloud sync is disabled. Bills are stored locally until you connect Supabase.': 'Sinkronizacija u oblaku je isključena. Računi se spremaju lokalno dok ne povežeš Supabase.',

    'Upgrade required': 'Potrebna je nadogradnja',
  },
  it: {
    app_title: 'BillBox',
    login_tagline: 'Fatture e garanzie in un unico posto.',
    checking_session: 'Verifica sessione…',

    email_placeholder: 'Email',
    password_placeholder: 'Password',
    confirm_password_placeholder: 'Conferma password',

    sign_in: 'Accedi',
    sign_up: 'Crea account',
    reset_password: 'Reimposta password',

    continue_as_email: 'Continua come {email}',

    error_generic: 'Qualcosa è andato storto. Riprova.',
    error_email_password_required: 'Email e password sono obbligatorie.',
    error_email_required: 'Email obbligatoria.',
    error_fill_required: 'Compila i campi obbligatori.',
    error_password_mismatch: 'Le password non coincidono.',

    auth_requires_cloud: 'Questa azione richiede la modalità cloud (Supabase).',
    auth_offline_hint: 'Sei in modalità offline. Puoi usare l’app localmente.',

    sign_up_success_check_email: 'Account creato. Controlla la tua email per confermare.',
    reset_password_success: 'Email di reset password inviata.',
    confirmation_email_sent: 'Email di conferma inviata.',

    social_not_configured: 'Accesso social non configurato per questa build.',
    google_sign_in: 'Continua con Google',
    apple_sign_in: 'Continua con Apple',

    forgot_password: 'Password dimenticata?',
    resend_confirmation: 'Reinvia conferma',
    create_account_prompt: 'Crea un account',
    back_to_sign_in: 'Torna al login',

    continue_without_login: 'Continua senza login',
    offline_mode: 'Modalità offline',

    language: 'Lingua',
    slovenian: 'Sloveno',
    english: 'Inglese',
    croatian: 'Croato',
    italian: 'Italiano',
    german: 'Tedesco',

    home: 'Home',
    scan: 'Scansiona',
    bills: 'Fatture',
    pay: 'Paga',
    settings: 'Impostazioni',

    // AI
    'AI assistant': 'Assistente AI',
    'AI unavailable': 'AI non disponibile',
    'Missing EXPO_PUBLIC_FUNCTIONS_BASE': 'Manca EXPO_PUBLIC_FUNCTIONS_BASE',
    'Here are a few helpful next steps.': 'Ecco alcuni prossimi passi utili.',
    'AI request failed.': 'Richiesta AI non riuscita.',
    'How can I help? Ask anything, or pick a suggestion.': 'Come posso aiutarti? Chiedi qualsiasi cosa o scegli un suggerimento.',
    Close: 'Chiudi',
    Open: 'Apri',
    'Thinking…': 'Sto pensando…',
    'Ask a question…': 'Fai una domanda…',
    Send: 'Invia',
    'Light mode': 'Modalità chiara',
    'Dark mode': 'Modalità scura',
    Payments: 'Pagamenti',

    'Preparing your workspace…': 'Sto preparando l’area di lavoro…',
    'Preparing payers…': 'Sto preparando i profili…',
    'Processing payment…': 'Elaborazione pagamento…',

    // Pay / Payments
    Today: 'Oggi',
    'This week': 'Questa settimana',
    Later: 'Più tardi',
    '{count} bills': '{count} fatture',
    'Current plan': 'Piano attuale',
    'Your plan': 'Il tuo piano',
    Profiles: 'Profili',
    Moje: 'Moje',
    'Več': 'Več',
    'Save €{amount} with yearly billing': 'Risparmia €{amount} con la fatturazione annuale',
    'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}':
      'Risparmia con fatturazione annuale: {planBasic} risparmia €{basicAmount} • {planPro} risparmia €{proAmount}',
    'Yearly (save €{amount})': 'Annuale (risparmia €{amount})',
    'OCR helps extract data from photos/PDFs. Limits reset monthly.': 'L’OCR aiuta a estrarre dati da foto/PDF. I limiti si azzerano ogni mese.',
    Payers: 'Profili',
    enabled: 'attivo',
    disabled: 'disattivo',
    Exports: 'Esportazioni',
    Free: 'Gratuito',
    Basic: 'Moje',
    Pro: 'Več',
    'Subscription plans': 'Piani di abbonamento',
    '€2.20 / month or €20 / year': '€2,20 / mese o €20 / anno',
    '€4 / month or €38 / year': '€4 / mese o €38 / anno',
    'Basic monthly': 'Moje mensile',
    'Basic yearly': 'Moje annuale',
    'Pro monthly': 'Več mensile',
    'Pro yearly': 'Več annuale',
    'Restore purchases': 'Ripristina acquisti',
    'Purchases unavailable': 'Acquisti non disponibili',
    'Purchases are available only in the store build.': 'Gli acquisti sono disponibili solo nella build dello store.',
    'Payments not configured': 'Pagamenti non configurati',
    'Product ID is missing in environment variables.': 'Product ID mancante nelle variabili d’ambiente.',
    'Subscription updated. Thank you!': 'Abbonamento aggiornato. Grazie!',
    'Verification failed': 'Verifica non riuscita',
    'We could not verify your purchase. Please try again later.': 'Non siamo riusciti a verificare l’acquisto. Riprova più tardi.',
    'Purchase error': 'Errore acquisto',
    'Something went wrong while processing the purchase.': 'Qualcosa è andato storto durante l’elaborazione dell’acquisto.',
    'No purchases': 'Nessun acquisto',
    'No previous purchases were found for this account.': 'Nessun acquisto precedente trovato per questo account.',
    'Purchases restored. Your plan is up to date.': 'Acquisti ripristinati. Il tuo piano è aggiornato.',
    'Restore failed': 'Ripristino non riuscito',
    'We could not restore your purchases. Please try again later.': 'Non siamo riusciti a ripristinare gli acquisti. Riprova più tardi.',
    'Restore error': 'Errore ripristino',
    'Something went wrong while restoring purchases.': 'Qualcosa è andato storto durante il ripristino degli acquisti.',

    // Bills / filters
    Bills: 'Fatture',
    'Untitled bill': 'Fattura senza titolo',
    attachment: 'allegato',
    attachments: 'allegati',
    'Default space': 'Spazio predefinito',
    'Invoice date': 'Data fattura',
    Created: 'Creato',
    'Loading space…': 'Caricamento spazio…',
    Filters: 'Filtri',
    'Filtering by {field}': 'Filtro per {field}',
    Due: 'Scadenza',
    Invoice: 'Fattura',
    'Date range': 'Intervallo date',
    'Start date': 'Data inizio',
    'End date': 'Data fine',
    'Unpaid only': 'Solo non pagate',
    Overdue: 'In ritardo',
    'Has attachment': 'Ha allegato',
    'Include archived': 'Includi archiviate',
    'Tap "Filters" to adjust date, supplier, amount, status, and attachments.': 'Tocca "Filtri" per modificare data, fornitore, importo, stato e allegati.',
    'Loading bills…': 'Caricamento fatture…',
    'Select date': 'Seleziona data',
    'Cloud sync is disabled. Bills are stored locally until you connect Supabase.': 'La sincronizzazione cloud è disattivata. Le fatture sono salvate localmente finché non colleghi Supabase.',

    'Upgrade required': 'Aggiornamento richiesto',
  },
  de: {
    app_title: 'BillBox',
    login_tagline: 'Rechnungen und Garantien an einem Ort.',
    checking_session: 'Sitzung wird geprüft…',

    email_placeholder: 'E-Mail',
    password_placeholder: 'Passwort',
    confirm_password_placeholder: 'Passwort bestätigen',

    sign_in: 'Anmelden',
    sign_up: 'Konto erstellen',
    reset_password: 'Passwort zurücksetzen',

    continue_as_email: 'Weiter als {email}',

    error_generic: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
    error_email_password_required: 'E-Mail und Passwort sind erforderlich.',
    error_email_required: 'E-Mail ist erforderlich.',
    error_fill_required: 'Bitte Pflichtfelder ausfüllen.',
    error_password_mismatch: 'Passwörter stimmen nicht überein.',

    auth_requires_cloud: 'Diese Aktion benötigt den Cloud-Modus (Supabase).',
    auth_offline_hint: 'Du bist im Offline-Modus. Du kannst die App lokal nutzen.',

    sign_up_success_check_email: 'Konto erstellt. Bitte E-Mail zur Bestätigung prüfen.',
    reset_password_success: 'E-Mail zum Zurücksetzen wurde gesendet.',
    confirmation_email_sent: 'Bestätigungs-E-Mail wurde gesendet.',

    social_not_configured: 'Social-Login ist in dieser Version nicht konfiguriert.',
    google_sign_in: 'Weiter mit Google',
    apple_sign_in: 'Weiter mit Apple',

    forgot_password: 'Passwort vergessen?',
    resend_confirmation: 'Bestätigung erneut senden',
    create_account_prompt: 'Konto erstellen',
    back_to_sign_in: 'Zurück zur Anmeldung',

    continue_without_login: 'Ohne Login fortfahren',
    offline_mode: 'Offline-Modus',

    language: 'Sprache',
    slovenian: 'Slowenisch',
    english: 'Englisch',
    croatian: 'Kroatisch',
    italian: 'Italienisch',
    german: 'Deutsch',

    home: 'Start',
    scan: 'Scannen',
    bills: 'Rechnungen',
    pay: 'Bezahlen',
    settings: 'Einstellungen',

    // AI
    'AI assistant': 'KI-Assistent',
    'AI unavailable': 'KI nicht verfügbar',
    'Missing EXPO_PUBLIC_FUNCTIONS_BASE': 'EXPO_PUBLIC_FUNCTIONS_BASE fehlt',
    'Here are a few helpful next steps.': 'Hier sind ein paar hilfreiche nächste Schritte.',
    'AI request failed.': 'KI-Anfrage fehlgeschlagen.',
    'How can I help? Ask anything, or pick a suggestion.': 'Wie kann ich helfen? Frag einfach oder wähle einen Vorschlag.',
    Close: 'Schließen',
    Open: 'Öffnen',
    'Thinking…': 'Ich denke nach…',
    'Ask a question…': 'Stelle eine Frage…',
    Send: 'Senden',
    'Light mode': 'Heller Modus',
    'Dark mode': 'Dunkler Modus',
    Payments: 'Zahlungen',

    'Preparing your workspace…': 'Arbeitsbereich wird vorbereitet…',
    'Preparing payers…': 'Profile werden vorbereitet…',
    'Processing payment…': 'Zahlung wird verarbeitet…',

    // Pay / Payments
    Today: 'Heute',
    'This week': 'Diese Woche',
    Later: 'Später',
    '{count} bills': '{count} Rechnungen',
    'Current plan': 'Aktueller Tarif',
    'Your plan': 'Dein Tarif',
    Profiles: 'Profile',
    Moje: 'Moje',
    'Več': 'Več',
    'Save €{amount} with yearly billing': 'Spare €{amount} mit jährlicher Abrechnung',
    'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}':
      'Spare mit jährlicher Abrechnung: {planBasic} spart €{basicAmount} • {planPro} spart €{proAmount}',
    'Yearly (save €{amount})': 'Jährlich (spare €{amount})',
    'OCR helps extract data from photos/PDFs. Limits reset monthly.': 'OCR hilft, Daten aus Fotos/PDFs zu extrahieren. Limits werden monatlich zurückgesetzt.',
    Payers: 'Profile',
    enabled: 'aktiv',
    disabled: 'inaktiv',
    Exports: 'Exporte',
    Free: 'Kostenlos',
    Basic: 'Moje',
    Pro: 'Več',
    'Subscription plans': 'Abonnementpläne',
    '€2.20 / month or €20 / year': '€2,20 / Monat oder €20 / Jahr',
    '€4 / month or €38 / year': '€4 / Monat oder €38 / Jahr',
    'Basic monthly': 'Moje monatlich',
    'Basic yearly': 'Moje jährlich',
    'Pro monthly': 'Več monatlich',
    'Pro yearly': 'Več jährlich',
    'Restore purchases': 'Käufe wiederherstellen',
    'Purchases unavailable': 'Käufe nicht verfügbar',
    'Purchases are available only in the store build.': 'Käufe sind nur in der Store-Build verfügbar.',
    'Payments not configured': 'Zahlungen nicht konfiguriert',
    'Product ID is missing in environment variables.': 'Product ID fehlt in den Umgebungsvariablen.',
    'Subscription updated. Thank you!': 'Abo aktualisiert. Danke!',
    'Verification failed': 'Verifizierung fehlgeschlagen',
    'We could not verify your purchase. Please try again later.': 'Wir konnten den Kauf nicht verifizieren. Bitte später erneut versuchen.',
    'Purchase error': 'Kauffehler',
    'Something went wrong while processing the purchase.': 'Beim Verarbeiten des Kaufs ist etwas schiefgelaufen.',
    'No purchases': 'Keine Käufe',
    'No previous purchases were found for this account.': 'Für dieses Konto wurden keine früheren Käufe gefunden.',
    'Purchases restored. Your plan is up to date.': 'Käufe wiederhergestellt. Dein Tarif ist aktuell.',
    'Restore failed': 'Wiederherstellung fehlgeschlagen',
    'We could not restore your purchases. Please try again later.': 'Wir konnten die Käufe nicht wiederherstellen. Bitte später erneut versuchen.',
    'Restore error': 'Wiederherstellungsfehler',
    'Something went wrong while restoring purchases.': 'Beim Wiederherstellen der Käufe ist etwas schiefgelaufen.',

    // Bills / filters
    Bills: 'Rechnungen',
    'Untitled bill': 'Unbenannte Rechnung',
    attachment: 'Anhang',
    attachments: 'Anhänge',
    'Default space': 'Standardbereich',
    'Invoice date': 'Rechnungsdatum',
    Created: 'Erstellt',
    'Loading space…': 'Bereich wird geladen…',
    Filters: 'Filter',
    'Filtering by {field}': 'Filter nach {field}',
    Due: 'Fällig',
    Invoice: 'Rechnung',
    'Date range': 'Datumsbereich',
    'Start date': 'Startdatum',
    'End date': 'Enddatum',
    'Unpaid only': 'Nur unbezahlt',
    Overdue: 'Überfällig',
    'Has attachment': 'Hat Anhang',
    'Include archived': 'Archivierte einschließen',
    'Tap "Filters" to adjust date, supplier, amount, status, and attachments.': 'Tippe auf "Filter", um Datum, Lieferant, Betrag, Status und Anhänge anzupassen.',
    'Loading bills…': 'Rechnungen werden geladen…',
    'Select date': 'Datum auswählen',
    'Cloud sync is disabled. Bills are stored locally until you connect Supabase.': 'Cloud-Synchronisierung ist deaktiviert. Rechnungen werden lokal gespeichert, bis du Supabase verbindest.',

    'Upgrade required': 'Upgrade erforderlich',
  },
}

for (const lang of Object.keys(phraseDict) as Lang[]) {
  Object.assign(dict[lang], phraseDict[lang])
}

export type I18nVars = Record<string, string | number>

const missingLogged: Record<string, true> = {}

function formatTemplate(template: string, vars?: I18nVars): string {
  if (!vars) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name) => {
    const val = (vars as any)[name]
    return val === undefined || val === null ? '' : String(val)
  })
}

export function t(lang: Lang, key: string, vars?: I18nVars): string {
  const table = dict[lang] || dict.en
  const fromLang = table[key]
  const fromEn = dict.en[key]
  const base = fromLang || fromEn || key

  // Dev-only: help keep translations complete.
  // We only warn when a non-English language is active and that language lacks a translation.
  try {
    const isDev = typeof __DEV__ !== 'undefined' && (__DEV__ as any)
    if (isDev && lang !== 'en' && !fromLang) {
      const missKey = `${lang}::${key}`
      if (!missingLogged[missKey]) {
        missingLogged[missKey] = true
        // eslint-disable-next-line no-console
        console.warn(`[i18n] Missing '${lang}' translation for: ${key}`)
      }
    }
  } catch {}

  return formatTemplate(base, vars)
}

export async function loadLang(): Promise<Lang> {
  try {
    const raw = await AsyncStorage.getItem(LS_LANG)
    const val = (raw || '').trim() as Lang
    if (val === 'sl' || val === 'en' || val === 'hr' || val === 'it' || val === 'de') {
      setCurrentLang(val)
      return val
    }
  } catch {}

  // First run / missing preference: pick a reasonable default from device locale.
  try {
    const loc = Localization.getLocales?.()?.[0]
    const locale = String(loc?.languageCode || loc?.languageTag || '').toLowerCase()
    const guessed: Lang =
      locale.startsWith('sl') ? 'sl' :
      locale.startsWith('hr') ? 'hr' :
      locale.startsWith('it') ? 'it' :
      locale.startsWith('de') ? 'de' :
      'en'
    setCurrentLang(guessed)
    return guessed
  } catch {
    setCurrentLang('en')
    return 'en'
  }
}

export async function saveLang(lang: Lang): Promise<void> {
  setCurrentLang(lang)
  try {
    await AsyncStorage.setItem(LS_LANG, lang)
  } catch {}
}
