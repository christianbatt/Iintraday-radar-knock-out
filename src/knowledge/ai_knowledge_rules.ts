/**
 * Registro delle regole di conoscenza — modalità SHADOW.
 *
 * Ogni voce è una regola di ricerca (AFML/MLAM, Chan, Bouchaud et al.) tradotta in una
 * direttiva operativa breve. Il registro è **solo descrittivo**: nessun modulo di trading lo
 * importa, nessuna regola filtra, pesa o riordina i setup, nessuna tocca i gate o le soglie di
 * src/config/tradingParams.ts. Le implementazioni testate stanno in ./shadowAlgorithms.ts.
 *
 * Tutte le voci hanno status "IPOTESI": non sono validate su trade reali e non sono attive.
 * Le regole nuove non vanno scritte in ai_specialization_memory.json: quel file è aggiornato
 * solo dal validatore (src/utils/learningValidator.ts + src/utils/memoryUpdater.ts) quando un
 * pattern supera i controlli statistici sui trade reali.
 */

export type KnowledgeDataSource = 'OHLCV_5m' | 'TICK' | 'L2';

export interface KnowledgeRule {
  /** Identificativo stabile della regola (R1..R11). */
  id: string;
  /** Libro/paper e capitolo/sezione di origine. */
  source: string;
  /** Direttiva operativa breve, in italiano. */
  directive: string;
  /** IPOTESI: nessuna regola è validata su trade reali in questo giro. */
  status: 'IPOTESI';
  /** Dati minimi richiesti per implementarla correttamente. */
  dataRequirement: KnowledgeDataSource;
  /** true solo se è implementabile con i dati disponibili nel progetto. */
  implementable: boolean;
  /** Come è implementata o perché non lo è; ogni soglia citata è IPOTESI. */
  implementationNote: string;
  /** Id del test che la copre, oppure null se non esiste un test. */
  validatedBy: string | null;
}

const TEST_FILE = 'src/utils/__tests__/knowledge_rules.test.ts';

export const KNOWLEDGE_RULES: KnowledgeRule[] = [
  {
    id: 'R1',
    source: 'AFML cap. 3 (López de Prado, Advances in Financial Machine Learning)',
    directive:
      'Etichettare ogni evento con la prima barriera colpita fra superiore (target), inferiore (stop) e verticale; la barriera verticale chiude i trade non risolti.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'tripleBarrierLabels(): percorso sulle barre chiuse, prima barriera toccata, etichetta +1/-1/0 e t1 per i pesi di unicità. IPOTESI: se il setup non definisce target/stop si usano ±2% (TRIPLE_BARRIER_UPPER/LOWER_HYPOTHESIS) e barriera verticale di 48 barre 5m; se in una barra vengono toccate entrambe le barriere decide il close.',
    validatedBy: `${TEST_FILE}#R1_triple_barrier`,
  },
  {
    id: 'R2',
    source: 'AFML cap. 4 (pesi per unicità dei campioni sovrapposti)',
    directive:
      'Trade con finestre temporali sovrapposte pesano meno: il peso di ogni campione è la media di 1/concorrenza sulle barre della sua finestra.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'sampleUniquenessWeights(): conteggio di concorrenza per barra e media di 1/concorrenza sulla finestra [t0,t1]; la somma dei pesi è pari alle barre distinte coperte.',
    validatedBy: `${TEST_FILE}#R2_uniqueness`,
  },
  {
    id: 'R3',
    source: 'AFML cap. 7 (cross-validation)',
    directive:
      'Purged k-fold con embargo: nessun campione di training si sovrappone alla finestra di test e nessuno inizia entro l embargo successivo.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'purgedKFold(): purge sui campioni la cui finestra interseca quella di test, embargo sui campioni che iniziano entro N barre dalla fine del test. IPOTESI: embargo in barre configurabile dal chiamante.',
    validatedBy: `${TEST_FILE}#R3_purged_kfold`,
  },
  {
    id: 'R4',
    source: 'AFML cap. 14; Bailey & López de Prado, The Deflated Sharpe Ratio',
    directive:
      'Correggere lo Sharpe per il numero di prove tentate: riportare il DSR sui trade chiusi e non fidarsi di uno Sharpe non deflazionato.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'deflatedSharpeRatio(): SR per-osservazione, SR0 atteso del massimo di T prove indipendenti (Bailey-LdP), DSR = Φ((SR−SR0)/√V[SR]). IPOTESI: T va dichiarato dal chiamante, con T < 2 il valore è null; è un campo informativo, non un gate.',
    validatedBy: `${TEST_FILE}#R4_dsr`,
  },
  {
    id: 'R5',
    source: 'AFML cap. 10 (bet sizing)',
    directive:
      'Size da Kelly frazionato con tetto: il LLM non calcola la size, la riceve da una funzione deterministica.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'fractionalKelly(): f* = p − (1−p)/b, size = clamp(frazione·f*, 0, tetto). IPOTESI: frazione 0.5 e tetto 0.25 (KELLY_FRACTION, KELLY_CAP) da validare sui trade reali. Con p = 0.5 e payoff 1 la size è 0.',
    validatedBy: `${TEST_FILE}#R5_kelly`,
  },
  {
    id: 'R6',
    source: 'AFML cap. 2 (barriere e campionamento degli eventi)',
    directive:
      'Campionare gli eventi con un filtro CUSUM simmetrico invece che a orologio: emettere un evento solo quando il prezzo si allontana di una soglia dal minimo/massimo corrente.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'cusumEventIndices(): cumulatori positivo/negativo con soglia h, reset a ogni evento. IPOTESI: h va calibrata sulla volatilità, qui è un parametro obbligatorio del chiamante.',
    validatedBy: `${TEST_FILE}#R6_cusum`,
  },
  {
    id: 'R7',
    source: 'Corwin & Schultz (2012); Amihud (2002)',
    directive:
      'Stimare spread e illiquidità da OHLC come proxy di costo: usarle solo come feature, sapendo che sono stime e non misure dirette.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'corwinSchultzSpreadProxy() su coppie di barre e amihudIlliquidity() = |r|/(close·volume)·1e6. IPOTESI: entrambe sovrastimano in presenza di gap e volatilità; la scala 1e6 è arbitraria. Mai usate come gate.',
    validatedBy: `${TEST_FILE}#R7_spread_amihud`,
  },
  {
    id: 'R8',
    source: 'AFML cap. 2 (volume bars / information bars)',
    directive:
      'Campionare per informazione (volume) invece che per tempo, per ridurre la correlazione delle barre nei periodi di attività disomogenea.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'Scelta: implementabile SOLO come approssimazione dichiarata (approximateVolumeBars, campo exact:false). Con barre 5m l ordine intrabar è ignoto, quindi il confine del bucket non coincide con il clock informativo di AFML e il test copre solo la meccanica di accumulo. In produzione servirebbero dati trade-level: la regola non è utilizzabile per l apprendimento finché non ci sono quei dati.',
    validatedBy: `${TEST_FILE}#R8_volume_bars`,
  },
  {
    id: 'R9',
    source: 'Bouchaud et al., Trades, Quotes and Prices (order flow, VPIN)',
    directive:
      'Misurare lo squilibrio di ordini (order flow imbalance, VPIN) per stimare la pressione direzionale e il rischio di tossicità del flusso.',
    status: 'IPOTESI',
    dataRequirement: 'L2',
    implementable: false,
    implementationNote:
      'Non implementabile: il feed del progetto è OHLCV 5m Yahoo, senza book, volumi per lato né aggressor side. VPIN richiede trade classificati buy/sell e bucket di volume; qualsiasi stima da OHLC sarebbe una finzione. Nessun test.',
    validatedBy: null,
  },
  {
    id: 'R10',
    source: 'Ipotesi operativa interna (da testare sui trade reali), ispirata a Chan, Algorithmic Trading',
    directive:
      'Concentrare l attenzione sulla prima ora della sessione regolare (US 09:30–10:30 ET, EU 09:00–10:00 Rome), dove il flusso informativo è più denso.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: true,
    implementationNote:
      'isHighProbabilityWindow(): fascia oraria calcolata con Intl sulla timezone di mercato e solo su barre già chiuse. IPOTESI non validata: nessun test, va confrontata con la distribuzione reale degli R-multipli per fascia.',
    validatedBy: null,
  },
  {
    id: 'R11',
    source: 'Regola prudenziale già presente come ai-rule-2 in ai_specialization_memory.json',
    directive:
      'Escludere i giorni di rilascio utili: spread e volatilità rendono inaffidabili stop e target su strumenti a leva.',
    status: 'IPOTESI',
    dataRequirement: 'OHLCV_5m',
    implementable: false,
    implementationNote:
      'Non implementabile nel codice attuale: il feed OHLCV non contiene il calendario earnings e non esiste una fonte eventi nel progetto. Resta una direttiva testuale (ai-rule-2) e non viene duplicata in memoria. Nessun test.',
    validatedBy: null,
  },
];

/** Regola per id, utile ai test e alla diagnostica. */
export function findKnowledgeRule(id: string): KnowledgeRule | undefined {
  return KNOWLEDGE_RULES.find((rule) => rule.id === id);
}
