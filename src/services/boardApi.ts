import type {
  ConceptBoard,
  ConceptBoardConstituent,
  ConceptBoardKline,
  ConceptBoardSpot,
  IndustryBoard,
  IndustryBoardConstituent,
  IndustryBoardKline,
  IndustryBoardSpot,
} from 'stock-sdk';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Board API request failed: ${response.status} ${url}`);
  }
  return response.json() as Promise<T>;
}

export async function getIndustryListApi(): Promise<IndustryBoard[]> {
  return getJson<IndustryBoard[]>('/api/boards/industry/list');
}

export async function getConceptListApi(): Promise<ConceptBoard[]> {
  return getJson<ConceptBoard[]>('/api/boards/concept/list');
}

export async function getIndustryConstituentsApi(code: string): Promise<IndustryBoardConstituent[]> {
  return getJson<IndustryBoardConstituent[]>(`/api/boards/industry/constituents?code=${encodeURIComponent(code)}`);
}

export async function getConceptConstituentsApi(code: string): Promise<ConceptBoardConstituent[]> {
  return getJson<ConceptBoardConstituent[]>(`/api/boards/concept/constituents?code=${encodeURIComponent(code)}`);
}

export async function getIndustrySpotApi(code: string): Promise<IndustryBoardSpot[]> {
  return getJson<IndustryBoardSpot[]>(`/api/boards/industry/spot?code=${encodeURIComponent(code)}`);
}

export async function getConceptSpotApi(code: string): Promise<ConceptBoardSpot[]> {
  return getJson<ConceptBoardSpot[]>(`/api/boards/concept/spot?code=${encodeURIComponent(code)}`);
}

export async function getIndustryKlineApi(code: string, period: string): Promise<IndustryBoardKline[]> {
  return getJson<IndustryBoardKline[]>(`/api/boards/industry/kline?code=${encodeURIComponent(code)}&period=${encodeURIComponent(period)}`);
}

export async function getConceptKlineApi(code: string, period: string): Promise<ConceptBoardKline[]> {
  return getJson<ConceptBoardKline[]>(`/api/boards/concept/kline?code=${encodeURIComponent(code)}&period=${encodeURIComponent(period)}`);
}
