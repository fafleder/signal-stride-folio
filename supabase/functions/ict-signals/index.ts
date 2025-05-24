
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

interface LiquidityZone {
  type: 'premium' | 'equilibrium' | 'discount' | 'liquidity_pool';
  price: number;
  strength: number;
}

interface TradeSignal {
  asset: string;
  timeframe: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  liquidity_zones: LiquidityZone[];
}

// Quarterly Theory Analysis
function analyzeQuarterlyBias(data: MarketData[]): 'bullish' | 'bearish' | 'neutral' {
  if (data.length < 60) return 'neutral'; // Need sufficient data
  
  const currentDate = new Date();
  const currentQuarter = Math.floor(currentDate.getMonth() / 3) + 1;
  const yearStart = new Date(currentDate.getFullYear(), 0, 1);
  
  // Get quarterly data points
  const q1End = new Date(currentDate.getFullYear(), 2, 31); // End of Q1
  const q2End = new Date(currentDate.getFullYear(), 5, 30); // End of Q2
  const q3End = new Date(currentDate.getFullYear(), 8, 30); // End of Q3
  
  const q1Data = data.filter(d => new Date(d.timestamp) <= q1End);
  const q2Data = data.filter(d => new Date(d.timestamp) <= q2End && new Date(d.timestamp) > q1End);
  const q3Data = data.filter(d => new Date(d.timestamp) <= q3End && new Date(d.timestamp) > q2End);
  
  if (q1Data.length === 0 || q2Data.length === 0) return 'neutral';
  
  const q2High = Math.max(...q2Data.map(d => d.high));
  const q3Low = q3Data.length > 0 ? Math.min(...q3Data.map(d => d.low)) : q2High;
  const currentPrice = data[data.length - 1].close;
  
  // ICT Quarterly Theory: Bullish if above Q2 high, Bearish if below Q3 low
  if (currentPrice > q2High) return 'bullish';
  if (currentPrice < q3Low) return 'bearish';
  return 'neutral';
}

// Identify Liquidity Pools (Equal Highs/Lows)
function identifyLiquidityPools(data: MarketData[]): LiquidityZone[] {
  const pools: LiquidityZone[] = [];
  const tolerance = 0.005; // 0.5% range
  
  // Find equal highs (resistance levels)
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  
  for (let i = 1; i < highs.length - 1; i++) {
    let equalHighs = 1;
    const baseHigh = highs[i];
    
    // Check for equal highs within tolerance
    for (let j = i + 1; j < Math.min(i + 10, highs.length); j++) {
      if (Math.abs(highs[j] - baseHigh) / baseHigh <= tolerance) {
        equalHighs++;
      }
    }
    
    if (equalHighs >= 2) {
      pools.push({
        type: 'liquidity_pool',
        price: baseHigh,
        strength: equalHighs
      });
    }
  }
  
  // Find equal lows (support levels)
  for (let i = 1; i < lows.length - 1; i++) {
    let equalLows = 1;
    const baseLow = lows[i];
    
    for (let j = i + 1; j < Math.min(i + 10, lows.length); j++) {
      if (Math.abs(lows[j] - baseLow) / baseLow <= tolerance) {
        equalLows++;
      }
    }
    
    if (equalLows >= 2) {
      pools.push({
        type: 'liquidity_pool',
        price: baseLow,
        strength: equalLows
      });
    }
  }
  
  return pools;
}

// PD Arrays (Premium, Discount, Equilibrium)
function calculatePDArrays(data: MarketData[]): LiquidityZone[] {
  const recentData = data.slice(-20); // Last 20 periods
  if (recentData.length < 20) return [];
  
  const highs = recentData.map(d => d.high);
  const lows = recentData.map(d => d.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;
  
  return [
    {
      type: 'premium',
      price: rangeLow + (range * 0.75), // Top 25%
      strength: 3
    },
    {
      type: 'equilibrium',
      price: rangeLow + (range * 0.5), // Middle 50%
      strength: 2
    },
    {
      type: 'discount',
      price: rangeLow + (range * 0.25), // Bottom 25%
      strength: 3
    }
  ];
}

// Detect Liquidity Sweeps and Runs
function detectLiquidityEvents(data: MarketData[], liquidityPools: LiquidityZone[]): boolean {
  if (data.length < 5) return false;
  
  const recentData = data.slice(-5);
  const avgVolume = data.slice(-20).reduce((sum, d) => sum + d.volume, 0) / 20;
  
  // Check for volume spikes (>2x average)
  const hasVolumeSpike = recentData.some(d => d.volume > avgVolume * 2);
  
  // Check for liquidity sweeps (price breaks level then reverses within 3 candles)
  for (const pool of liquidityPools) {
    const breakData = recentData.slice(0, 3);
    const reversalData = recentData.slice(-3);
    
    const hasBreak = breakData.some(d => d.high > pool.price || d.low < pool.price);
    const hasReversal = reversalData.some(d => 
      (d.close > pool.price && breakData.some(bd => bd.low < pool.price)) ||
      (d.close < pool.price && breakData.some(bd => bd.high > pool.price))
    );
    
    if (hasBreak && hasReversal && hasVolumeSpike) {
      return true;
    }
  }
  
  return false;
}

// Generate ICT Trading Signal
function generateICTSignal(asset: string, data: MarketData[]): TradeSignal | null {
  if (data.length < 60) return null;
  
  const bias = analyzeQuarterlyBias(data);
  const liquidityPools = identifyLiquidityPools(data);
  const pdArrays = calculatePDArrays(data);
  const hasLiquidityEvent = detectLiquidityEvents(data, liquidityPools);
  
  if (bias === 'neutral' || !hasLiquidityEvent) return null;
  
  const currentPrice = data[data.length - 1].close;
  const atr = calculateATR(data.slice(-14)); // 14-period ATR
  
  let entry_price = currentPrice;
  let stop_loss: number;
  let take_profit: number;
  
  if (bias === 'bullish') {
    // Look for discount entries
    const discountZone = pdArrays.find(pd => pd.type === 'discount');
    if (discountZone) entry_price = discountZone.price;
    
    stop_loss = entry_price - (atr * 1.5);
    take_profit = entry_price + (atr * 3);
  } else {
    // Look for premium entries
    const premiumZone = pdArrays.find(pd => pd.type === 'premium');
    if (premiumZone) entry_price = premiumZone.price;
    
    stop_loss = entry_price + (atr * 1.5);
    take_profit = entry_price - (atr * 3);
  }
  
  return {
    asset,
    timeframe: '5min',
    bias,
    entry_price,
    stop_loss,
    take_profit,
    liquidity_zones: [...liquidityPools, ...pdArrays]
  };
}

// Calculate Average True Range
function calculateATR(data: MarketData[]): number {
  if (data.length < 2) return 0;
  
  const trueRanges = [];
  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const previous = data[i - 1];
    
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);
    
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }
  
  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

async function storeTradeSignal(signal: TradeSignal) {
  const { data, error } = await supabase
    .from('trade_signals')
    .insert({
      asset: signal.asset,
      timeframe: signal.timeframe,
      bias: signal.bias,
      entry_price: signal.entry_price,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      liquidity_zones: signal.liquidity_zones
    });
  
  if (error) {
    console.error('Error storing trade signal:', error);
    throw error;
  }
  
  return data;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    if (url.pathname === '/ict-signals') {
      if (req.method === 'GET') {
        // Get existing signals
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
        console.log('Generating ICT signals...');
        
        // Get market data for analysis
        const { data: marketData, error: marketError } = await supabase
          .from('market_data')
          .select('*')
          .order('timestamp', { ascending: true })
          .limit(500);
        
        if (marketError) throw marketError;
        
        const xauusdData = marketData.filter(d => d.asset === 'XAUUSD');
        const nasdaqData = marketData.filter(d => d.asset === 'NASDAQ');
        
        const signals: TradeSignal[] = [];
        
        // Generate signals for XAUUSD
        if (xauusdData.length > 0) {
          const xauSignal = generateICTSignal('XAUUSD', xauusdData);
          if (xauSignal) {
            signals.push(xauSignal);
            await storeTradeSignal(xauSignal);
            console.log('Generated XAUUSD signal:', xauSignal.bias);
          }
        }
        
        // Generate signals for NASDAQ
        if (nasdaqData.length > 0) {
          const nasdaqSignal = generateICTSignal('NASDAQ', nasdaqData);
          if (nasdaqSignal) {
            signals.push(nasdaqSignal);
            await storeTradeSignal(nasdaqSignal);
            console.log('Generated NASDAQ signal:', nasdaqSignal.bias);
          }
        }
        
        return new Response(JSON.stringify({ 
          success: true,
          signals,
          message: `Generated ${signals.length} ICT signals`
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
    console.error('Error in ICT signals function:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Check function logs for more information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
