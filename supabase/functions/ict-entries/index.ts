
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface MarketData {
  timestamp: string;
  asset: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface EntrySignal {
  asset: string;
  timeframe: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  bias: 'bullish' | 'bearish';
  confidence: number;
}

// OHLC Pattern Analysis
function detectEngulfing(data: MarketData[]): { bullish: boolean; bearish: boolean } {
  if (data.length < 2) return { bullish: false, bearish: false };
  
  const current = data[data.length - 1];
  const previous = data[data.length - 2];
  
  const bullishEngulfing = 
    previous.close < previous.open && // Previous bearish
    current.close > current.open && // Current bullish
    current.open < previous.close && // Current opens below previous close
    current.close > previous.open; // Current closes above previous open
  
  const bearishEngulfing = 
    previous.close > previous.open && // Previous bullish
    current.close < current.open && // Current bearish
    current.open > previous.close && // Current opens above previous close
    current.close < previous.open; // Current closes below previous open
  
  return { bullish: bullishEngulfing, bearish: bearishEngulfing };
}

function detectDoji(candle: MarketData): boolean {
  const bodySize = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  return bodySize / range <= 0.001; // 0.1% threshold
}

// Turtle Soup Pattern
function detectTurtleSoup(data: MarketData[]): { bullish: boolean; bearish: boolean } {
  if (data.length < 22) return { bullish: false, bearish: false };
  
  const recent = data.slice(-22);
  const last20 = recent.slice(0, 20);
  const breakoutCandles = recent.slice(-2);
  
  const high20 = Math.max(...last20.map(d => d.high));
  const low20 = Math.min(...last20.map(d => d.low));
  
  // Check for false breakout above high20 (bearish soup)
  const falseBreakoutUp = 
    breakoutCandles[0].high > high20 && // First candle breaks high
    breakoutCandles[1].close < high20; // Second candle closes back below
  
  // Check for false breakout below low20 (bullish soup)
  const falseBreakoutDown = 
    breakoutCandles[0].low < low20 && // First candle breaks low
    breakoutCandles[1].close > low20; // Second candle closes back above
  
  return { bullish: falseBreakoutDown, bearish: falseBreakoutUp };
}

// CRT (Constant Range Time)
function detectCRT(data: MarketData[]): boolean {
  if (data.length < 6) return false;
  
  const recent = data.slice(-6);
  const highs = recent.map(d => d.high);
  const lows = recent.map(d => d.low);
  
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;
  const midPoint = (rangeHigh + rangeLow) / 2;
  
  // Check if all candles stay within 0.5% range
  const rangePercent = range / midPoint;
  return rangePercent <= 0.005; // 0.5% threshold
}

// PD Array Analysis
function analyzePDArrays(data: MarketData[]): {
  premium: number;
  equilibrium: number;
  discount: number;
  current: number;
  zone: 'premium' | 'equilibrium' | 'discount';
} {
  const recentData = data.slice(-20);
  if (recentData.length < 20) return {
    premium: 0, equilibrium: 0, discount: 0, current: 0, zone: 'equilibrium'
  };
  
  const highs = recentData.map(d => d.high);
  const lows = recentData.map(d => d.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;
  
  const premium = rangeLow + (range * 0.75);
  const equilibrium = rangeLow + (range * 0.5);
  const discount = rangeLow + (range * 0.25);
  const current = data[data.length - 1].close;
  
  let zone: 'premium' | 'equilibrium' | 'discount' = 'equilibrium';
  if (current >= premium) zone = 'premium';
  else if (current <= discount) zone = 'discount';
  
  return { premium, equilibrium, discount, current, zone };
}

// PD Array Entry Detection
function detectPDArrayEntries(data: MarketData[], pdArrays: any): {
  rejection: boolean;
  breakout: boolean;
  direction: 'bullish' | 'bearish' | null;
} {
  if (data.length < 3) return { rejection: false, breakout: false, direction: null };
  
  const recent = data.slice(-3);
  const current = recent[2];
  const previous = recent[1];
  
  // Rejection in premium zone (bearish)
  if (pdArrays.zone === 'premium') {
    const rejection = 
      previous.high >= pdArrays.premium && // Touched premium
      current.close < previous.low; // Reversed down
    
    if (rejection) return { rejection: true, breakout: false, direction: 'bearish' };
  }
  
  // Rejection in discount zone (bullish)
  if (pdArrays.zone === 'discount') {
    const rejection = 
      previous.low <= pdArrays.discount && // Touched discount
      current.close > previous.high; // Reversed up
    
    if (rejection) return { rejection: true, breakout: false, direction: 'bullish' };
  }
  
  // Breakout detection
  const breakoutUp = current.close > pdArrays.premium;
  const breakoutDown = current.close < pdArrays.discount;
  
  if (breakoutUp) return { rejection: false, breakout: true, direction: 'bullish' };
  if (breakoutDown) return { rejection: false, breakout: true, direction: 'bearish' };
  
  return { rejection: false, breakout: false, direction: null };
}

// Market Maker Model/IPDA Analysis
function analyzeIPDA(data: MarketData[], pdArrays: any): {
  shouldBuy: boolean;
  shouldSell: boolean;
  phase: string;
} {
  const currentDate = new Date();
  const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;
  
  // Q2 Markup Phase - Buy in discount zones
  if (currentQuarter === 2 && pdArrays.zone === 'discount') {
    return { shouldBuy: true, shouldSell: false, phase: 'Q2_Markup' };
  }
  
  // Q3 Distribution Phase - Sell in premium zones
  if (currentQuarter === 3 && pdArrays.zone === 'premium') {
    return { shouldBuy: false, shouldSell: true, phase: 'Q3_Distribution' };
  }
  
  return { shouldBuy: false, shouldSell: false, phase: 'Neutral' };
}

// ATR Calculation
function calculateATR(data: MarketData[], period = 20): number {
  if (data.length < period + 1) return 0;
  
  const trueRanges = [];
  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const previous = data[i - 1];
    
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);
    
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }
  
  return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
}

// Volatility Analysis
function analyzeVolatility(data: MarketData[]): { isHighVolatility: boolean; currentATR: number; avgATR: number } {
  const currentATR = calculateATR(data.slice(-14), 14);
  const avgATR = calculateATR(data.slice(-34, -14), 20);
  
  return {
    isHighVolatility: currentATR > avgATR,
    currentATR,
    avgATR
  };
}

// Quarterly Bias
function getQuarterlyBias(data: MarketData[]): 'bullish' | 'bearish' | 'neutral' {
  if (data.length < 60) return 'neutral';
  
  const currentDate = new Date();
  const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;
  const yearStart = new Date(currentDate.getFullYear(), 0, 1);
  
  const q1End = new Date(currentDate.getFullYear(), 2, 31);
  const q2End = new Date(currentDate.getFullYear(), 5, 30);
  const q3End = new Date(currentDate.getFullYear(), 8, 30);
  
  const q2Data = data.filter(d => {
    const date = new Date(d.timestamp);
    return date <= q2End && date > q1End;
  });
  const q3Data = data.filter(d => {
    const date = new Date(d.timestamp);
    return date <= q3End && date > q2End;
  });
  
  if (q2Data.length === 0) return 'neutral';
  
  const q2High = Math.max(...q2Data.map(d => d.high));
  const q3Low = q3Data.length > 0 ? Math.min(...q3Data.map(d => d.low)) : q2High;
  const currentPrice = data[data.length - 1].close;
  
  if (currentPrice > q2High) return 'bullish';
  if (currentPrice < q3Low) return 'bearish';
  return 'neutral';
}

// Generate Entry Signals
function generateEntrySignals(asset: string, data: MarketData[]): EntrySignal[] {
  if (data.length < 60) return [];
  
  const signals: EntrySignal[] = [];
  const currentPrice = data[data.length - 1].close;
  const atr = calculateATR(data);
  const volatility = analyzeVolatility(data);
  const bias = getQuarterlyBias(data);
  const pdArrays = analyzePDArrays(data);
  
  // Only generate signals in high volatility conditions
  if (!volatility.isHighVolatility) return [];
  
  // Pattern Detection
  const engulfing = detectEngulfing(data);
  const hasDoji = detectDoji(data[data.length - 1]);
  const turtleSoup = detectTurtleSoup(data);
  const crt = detectCRT(data);
  const pdEntries = detectPDArrayEntries(data, pdArrays);
  const ipda = analyzeIPDA(data, pdArrays);
  
  // Engulfing Pattern Entries
  if (engulfing.bullish && bias !== 'bearish') {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'Bullish_Engulfing',
      entry_price: currentPrice,
      stop_loss: currentPrice - (atr * 1.5),
      take_profit: currentPrice + (atr * 3),
      bias: 'bullish',
      confidence: 0.7
    });
  }
  
  if (engulfing.bearish && bias !== 'bullish') {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'Bearish_Engulfing',
      entry_price: currentPrice,
      stop_loss: currentPrice + (atr * 1.5),
      take_profit: currentPrice - (atr * 3),
      bias: 'bearish',
      confidence: 0.7
    });
  }
  
  // Turtle Soup Entries
  if (turtleSoup.bullish) {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'Turtle_Soup_Bullish',
      entry_price: currentPrice,
      stop_loss: currentPrice - (atr * 1.5),
      take_profit: currentPrice + (atr * 3),
      bias: 'bullish',
      confidence: 0.8
    });
  }
  
  if (turtleSoup.bearish) {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'Turtle_Soup_Bearish',
      entry_price: currentPrice,
      stop_loss: currentPrice + (atr * 1.5),
      take_profit: currentPrice - (atr * 3),
      bias: 'bearish',
      confidence: 0.8
    });
  }
  
  // CRT Breakout Entries (wait for breakout after consolidation)
  if (crt && bias === 'bullish' && currentPrice > pdArrays.equilibrium) {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'CRT_Breakout_Bullish',
      entry_price: currentPrice,
      stop_loss: currentPrice - (atr * 1.5),
      take_profit: currentPrice + (atr * 3),
      bias: 'bullish',
      confidence: 0.6
    });
  }
  
  if (crt && bias === 'bearish' && currentPrice < pdArrays.equilibrium) {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'CRT_Breakout_Bearish',
      entry_price: currentPrice,
      stop_loss: currentPrice + (atr * 1.5),
      take_profit: currentPrice - (atr * 3),
      bias: 'bearish',
      confidence: 0.6
    });
  }
  
  // PD Array Rejection Entries
  if (pdEntries.rejection && pdEntries.direction) {
    const entryBias = pdEntries.direction;
    signals.push({
      asset,
      timeframe: '5min',
      strategy: `PD_Array_Rejection_${entryBias}`,
      entry_price: currentPrice,
      stop_loss: entryBias === 'bullish' ? 
        currentPrice - (atr * 1.5) : currentPrice + (atr * 1.5),
      take_profit: entryBias === 'bullish' ? 
        currentPrice + (atr * 3) : currentPrice - (atr * 3),
      bias: entryBias,
      confidence: 0.75
    });
  }
  
  // IPDA/Market Maker Model Entries
  if (ipda.shouldBuy && bias !== 'bearish') {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'IPDA_Discount_Buy',
      entry_price: currentPrice,
      stop_loss: currentPrice - (atr * 1.5),
      take_profit: currentPrice + (atr * 3),
      bias: 'bullish',
      confidence: 0.85
    });
  }
  
  if (ipda.shouldSell && bias !== 'bullish') {
    signals.push({
      asset,
      timeframe: '5min',
      strategy: 'IPDA_Premium_Sell',
      entry_price: currentPrice,
      stop_loss: currentPrice + (atr * 1.5),
      take_profit: currentPrice - (atr * 3),
      bias: 'bearish',
      confidence: 0.85
    });
  }
  
  return signals;
}

async function storeEntrySignals(signals: EntrySignal[]) {
  const signalsToStore = signals.map(signal => ({
    asset: signal.asset,
    timeframe: signal.timeframe,
    bias: signal.bias,
    entry_price: signal.entry_price,
    stop_loss: signal.stop_loss,
    take_profit: signal.take_profit,
    liquidity_zones: {
      strategy: signal.strategy,
      confidence: signal.confidence
    }
  }));
  
  if (signalsToStore.length === 0) return [];
  
  const { data, error } = await supabase
    .from('trade_signals')
    .insert(signalsToStore);
  
  if (error) {
    console.error('Error storing entry signals:', error);
    throw error;
  }
  
  return data;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    if (url.pathname === '/entries') {
      if (req.method === 'GET') {
        // Get existing entry signals
        const { data, error } = await supabase
          .from('trade_signals')
          .select('*')
          .order('id', { ascending: false })
          .limit(50);
        
        if (error) throw error;
        
        return new Response(JSON.stringify({ signals: data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (req.method === 'POST') {
        console.log('Generating ICT entry signals...');
        
        // Get market data for analysis
        const { data: marketData, error: marketError } = await supabase
          .from('market_data')
          .select('*')
          .order('timestamp', { ascending: true })
          .limit(500);
        
        if (marketError) throw marketError;
        
        const xauusdData = marketData.filter(d => d.asset === 'XAUUSD');
        const nasdaqData = marketData.filter(d => d.asset === 'NASDAQ');
        
        const allSignals: EntrySignal[] = [];
        
        // Generate entry signals for XAUUSD
        if (xauusdData.length > 0) {
          const xauSignals = generateEntrySignals('XAUUSD', xauusdData);
          allSignals.push(...xauSignals);
          console.log(`Generated ${xauSignals.length} XAUUSD entry signals`);
        }
        
        // Generate entry signals for NASDAQ
        if (nasdaqData.length > 0) {
          const nasdaqSignals = generateEntrySignals('NASDAQ', nasdaqData);
          allSignals.push(...nasdaqSignals);
          console.log(`Generated ${nasdaqSignals.length} NASDAQ entry signals`);
        }
        
        // Store signals in database
        if (allSignals.length > 0) {
          await storeEntrySignals(allSignals);
        }
        
        return new Response(JSON.stringify({ 
          success: true,
          signals: allSignals,
          message: `Generated ${allSignals.length} ICT entry signals`
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error in ICT entries function:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Check function logs for more information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
