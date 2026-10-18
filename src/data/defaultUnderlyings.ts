import { UnderlyingItem } from '../types/radar';

export const DEFAULT_TRADE_REPUBLIC_UNDERLYINGS: UnderlyingItem[] = [
  // Europa (Xetra, Euronext, Piazza Affari) - Sottostanti tipici Knock-Out Trade Republic
  { ticker: 'SAP.DE', nome: 'SAP SE', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'ASML.AS', nome: 'ASML Holding', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'MC.PA', nome: 'LVMH Moët Hennessy', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'RHM.DE', nome: 'Rheinmetall AG', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'STMMI.MI', nome: 'STMicroelectronics N.V.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'LEO.MI', nome: 'Leonardo S.p.A.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'ENI.MI', nome: 'Eni S.p.A.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'ENEL.MI', nome: 'Enel S.p.A.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'ISP.MI', nome: 'Intesa Sanpaolo', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'RACE.MI', nome: 'Ferrari N.V.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'SIE.DE', nome: 'Siemens AG', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'UCG.MI', nome: 'UniCredit S.p.A.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'STLAM.MI', nome: 'Stellantis N.V.', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'AIR.PA', nome: 'Airbus SE', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'MBG.DE', nome: 'Mercedes-Benz Group AG', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'TTE.PA', nome: 'TotalEnergies SE', mercato: 'EU', valuta: 'EUR' },
  { ticker: 'ALV.DE', nome: 'Allianz SE', mercato: 'EU', valuta: 'EUR' },

  // USA (Nasdaq, NYSE) - Sottostanti tipici Knock-Out Trade Republic
  { ticker: 'NVDA', nome: 'NVIDIA Corporation', mercato: 'US', valuta: 'USD' },
  { ticker: 'AAPL', nome: 'Apple Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'TSLA', nome: 'Tesla Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'MSFT', nome: 'Microsoft Corporation', mercato: 'US', valuta: 'USD' },
  { ticker: 'AMZN', nome: 'Amazon.com Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'META', nome: 'Meta Platforms Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'GOOGL', nome: 'Alphabet Inc. Class A', mercato: 'US', valuta: 'USD' },
  { ticker: 'AMD', nome: 'Advanced Micro Devices', mercato: 'US', valuta: 'USD' },
  { ticker: 'ARM', nome: 'Arm Holdings plc', mercato: 'US', valuta: 'USD' },
  { ticker: 'MU', nome: 'Micron Technology Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'MSTR', nome: 'MicroStrategy Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'QCOM', nome: 'Qualcomm Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'MARA', nome: 'MARA Holdings Inc.', mercato: 'US', valuta: 'USD' },
  { ticker: 'PLTR', nome: 'Palantir Technologies', mercato: 'US', valuta: 'USD' },
  { ticker: 'COIN', nome: 'Coinbase Global Inc.', mercato: 'US', valuta: 'USD' },
];

export function parseUnderlyingsCsv(csvText: string): { items: UnderlyingItem[]; errors: string[] } {
  const lines = csvText.trim().split(/\r?\n/);
  const items: UnderlyingItem[] = [];
  const errors: string[] = [];

  if (lines.length < 2) {
    return { items: [], errors: ['Il file CSV è vuoto o privo di righe di intestazione'] };
  }

  // Parse header
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/^["']|["']$/g, ''));
  const tickerIdx = header.findIndex((h) => h === 'ticker');
  const nomeIdx = header.findIndex((h) => h === 'nome' || h === 'name');
  const mercatoIdx = header.findIndex((h) => h === 'mercato' || h === 'market');
  const valutaIdx = header.findIndex((h) => h === 'valuta' || h === 'currency');

  if (tickerIdx === -1 || nomeIdx === -1 || mercatoIdx === -1 || valutaIdx === -1) {
    return {
      items: [],
      errors: [
        'Intestazione CSV non valida. Colonne richieste tassativamente: ticker, nome, mercato, valuta',
      ],
    };
  }

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    // Handle comma split respecting quotes
    const cols = rawLine.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length < 4) {
      errors.push(`Riga ${i + 1} ignorata: colonne insufficienti (${rawLine})`);
      continue;
    }

    const ticker = cols[tickerIdx]?.toUpperCase();
    const nome = cols[nomeIdx];
    const rawMercato = cols[mercatoIdx]?.toUpperCase();
    const valuta = cols[valutaIdx]?.toUpperCase();

    if (!ticker) {
      errors.push(`Riga ${i + 1} ignorata: ticker vuoto`);
      continue;
    }

    const mercato: 'EU' | 'US' = rawMercato === 'US' || rawMercato === 'USA' ? 'US' : 'EU';

    items.push({
      ticker,
      nome: nome || ticker,
      mercato,
      valuta: valuta || (mercato === 'EU' ? 'EUR' : 'USD'),
    });
  }

  return { items, errors };
}

export function exportUnderlyingsToCsv(items: UnderlyingItem[]): string {
  const header = 'ticker,nome,mercato,valuta';
  const rows = items.map((item) => `"${item.ticker}","${item.nome}","${item.mercato}","${item.valuta}"`);
  return [header, ...rows].join('\n');
}
