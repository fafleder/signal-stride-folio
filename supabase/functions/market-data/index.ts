
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALPHA_VANTAGE_API_KEY = Deno.env.get('ALPHA_VANTAGE_API_KEY');
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;

const supabase = createClient(supabaseUrl, supabaseKey);

// Rate limiting: 5 calls per minute
let lastCallTime = 0;
const RATE_LIMIT_DELAY = 12000; // 12 seconds between calls (5 calls/min)

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeAPICallWithRetry(url: string, maxRetries = 3): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} for URL: ${url}`);
      
      // Rate limiting
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTime;
      if (timeSinceLastCall < RATE_LIMIT_DELAY) {
        const waitTime = RATE_LIMIT_DELAY - timeSinceLastCall;
        console.log(`Rate limiting: waiting ${waitTime}ms`);
        await delay(waitTime);
      }
      lastCallTime = Date.now();

      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data['Error Message']) {
        throw new Error(`Alpha Vantage error: ${data['Error Message']}`);
      }
      
      if (data['Note']) {
        throw new Error(`Rate limit exceeded: ${data['Note']}`);
      }
      
      return data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait 5 seconds before retry
      console.log('Waiting 5 seconds before retry...');
      await delay(5000);
    }
  }
}

async function fetchXAUUSD() {
  const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=XAU&to_symbol=USD&interval=5min&apikey=${ALPHA_VANTAGE_API_KEY}`;
  
  const data = await makeAPICallWithRetry(url);
  const timeSeries = data['Time Series FX (5min)'];
  
  if (!timeSeries) {
    throw new Error('No forex data received for XAUUSD');
  }
  
  const marketData = [];
  for (const [timestamp, values] of Object.entries(timeSeries)) {
    marketData.push({
      timestamp: new Date(timestamp).toISOString(),
      asset: 'XAUUSD',
      open: parseFloat(values['1. open']),
      high: parseFloat(values['2. high']),
      low: parseFloat(values['3. low']),
      close: parseFloat(values['4. close']),
      volume: 0 // Forex doesn't have volume data
    });
  }
  
  return marketData.slice(0, 100); // Limit to latest 100 records
}

async function fetchNASDAQ() {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=IXIC&interval=5min&apikey=${ALPHA_VANTAGE_API_KEY}`;
  
  const data = await makeAPICallWithRetry(url);
  const timeSeries = data['Time Series (5min)'];
  
  if (!timeSeries) {
    throw new Error('No index data received for NASDAQ');
  }
  
  const marketData = [];
  for (const [timestamp, values] of Object.entries(timeSeries)) {
    marketData.push({
      timestamp: new Date(timestamp).toISOString(),
      asset: 'NASDAQ',
      open: parseFloat(values['1. open']),
      high: parseFloat(values['2. high']),
      low: parseFloat(values['3. low']),
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume'])
    });
  }
  
  return marketData.slice(0, 100); // Limit to latest 100 records
}

async function storeMarketData(marketData: any[]) {
  const { data, error } = await supabase
    .from('market_data')
    .upsert(marketData, { 
      onConflict: 'timestamp,asset',
      ignoreDuplicates: true 
    });
  
  if (error) {
    console.error('Error storing market data:', error);
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
    
    if (url.pathname === '/market-data') {
      if (req.method === 'GET') {
        // Fetch latest data from database
        const { data, error } = await supabase
          .from('market_data')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(200);
        
        if (error) {
          throw error;
        }
        
        return new Response(JSON.stringify({ data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (req.method === 'POST') {
        // Fetch and store new data
        console.log('Starting market data fetch...');
        
        const allMarketData = [];
        
        try {
          console.log('Fetching XAUUSD data...');
          const xauusdData = await fetchXAUUSD();
          allMarketData.push(...xauusdData);
          console.log(`Fetched ${xauusdData.length} XAUUSD records`);
        } catch (error) {
          console.error('Failed to fetch XAUUSD:', error);
        }
        
        try {
          console.log('Fetching NASDAQ data...');
          const nasdaqData = await fetchNASDAQ();
          allMarketData.push(...nasdaqData);
          console.log(`Fetched ${nasdaqData.length} NASDAQ records`);
        } catch (error) {
          console.error('Failed to fetch NASDAQ:', error);
        }
        
        if (allMarketData.length > 0) {
          await storeMarketData(allMarketData);
          console.log(`Stored ${allMarketData.length} total records`);
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          recordsProcessed: allMarketData.length,
          message: 'Market data updated successfully'
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
    console.error('Error in market-data function:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Check function logs for more information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
