const supabase = require('../config/supabase');
const { getLastFeedSyncAt } = require('../services/syncScheduler');

const getListings = async (req, res) => {
  const { officeId, agentId } = req.query;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 INCOMING REQUEST');
  console.log('   URL        :', req.originalUrl);
  console.log('   officeId   :', officeId   ?? 'NOT PROVIDED');
  console.log('   agentId    :', agentId    ?? 'NOT PROVIDED');
  console.log('   IP         :', req.ip);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!officeId) {
    console.log('❌ REJECTED: officeId is missing');
    return res.status(400).json({ success: false, message: 'officeId is required' });
  }

  let query = supabase
    .from('listings')
    .select('listing_key, office_mls_id, agent_mls_id, modification_timestamp, list_price, standard_status, city, postal_code, bedrooms_total, bathrooms_total, property_type, living_area, raw_data')
    .eq('office_mls_id', officeId)
    .eq('mlg_can_view', true)
    .order('list_price', { ascending: false });

  if (agentId) {
    console.log('🔍 agentId received (used for featured badging on frontend):', agentId);
  }

  const { data, error } = await query;

  if (error) {
    console.log('❌ SUPABASE ERROR:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }

  const feedSyncAt = getLastFeedSyncAt() || new Date().toISOString();
  const latestListingTs = data?.reduce((latest, l) => {
    const ts = l.modification_timestamp || l.raw_data?.ModificationTimestamp;
    if (!ts) return latest;
    return (!latest || ts > latest) ? ts : latest;
  }, null);

  console.log('✅ OUTGOING RESPONSE');
  console.log('   Listings found :', data.length);
  console.log('   Feed Synced At :', feedSyncAt);
  if (data.length > 0) {
    data.slice(0, 3).forEach((l, i) => {
      console.log(`   [${i + 1}] ${l.listing_key} | ${l.standard_status} | $${l.list_price} | ${l.city}`);
    });
  } else {
    console.log('   ⚠️  No listings matched the query');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  res.json({
    success: true,
    count: data.length,
    lastUpdated: feedSyncAt,
    latestListingTs,
    listings: data,
  });
};

const getListing = async (req, res) => {
  const { id } = req.params;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 SINGLE LISTING REQUEST');
  console.log('   listingKey :', id);
  console.log('   IP         :', req.ip);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('listing_key', id)
    .single();

  if (error) {
    console.log('❌ SUPABASE ERROR:', error.message);
    return res.status(404).json({ success: false, message: 'Listing not found' });
  }

  const feedSyncAt = getLastFeedSyncAt() || new Date().toISOString();
  console.log('✅ Returning listing:', data.listing_key, '|', data.city, '| $' + data.list_price);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  res.json({ success: true, feedLastSyncAt: feedSyncAt, listing: data });
};

const getFeaturedListings = async (req, res) => {
  const { agentId, officeId, limit } = req.query;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⭐ FEATURED LISTINGS REQUEST');
  console.log('   agentId    :', agentId  ?? 'NOT PROVIDED');
  console.log('   officeId   :', officeId ?? 'OPTIONAL');
  console.log('   limit      :', limit    ?? 'ALL');
  console.log('   IP         :', req.ip);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!agentId) {
    console.log('❌ REJECTED: agentId is missing');
    return res.status(400).json({ success: false, message: 'agentId is required' });
  }

  let query = supabase
    .from('listings')
    .select('listing_key, office_mls_id, agent_mls_id, modification_timestamp, list_price, standard_status, city, postal_code, bedrooms_total, bathrooms_total, property_type, living_area, raw_data')
    .eq('agent_mls_id', agentId)
    .eq('mlg_can_view', true)
    .order('list_price', { ascending: false });

  if (officeId) {
    query = query.eq('office_mls_id', officeId);
  }

  if (limit && !isNaN(parseInt(limit, 10))) {
    query = query.limit(parseInt(limit, 10));
  }

  const { data, error } = await query;

  if (error) {
    console.log('❌ SUPABASE ERROR (featured):', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }

  const feedSyncAt = getLastFeedSyncAt() || new Date().toISOString();
  console.log('✅ Returning featured listings count:', data.length);
  if (data.length > 0) {
    data.slice(0, 3).forEach((l, i) => {
      console.log(`   [${i + 1}] ${l.listing_key} | $${l.list_price} | ${l.city}`);
    });
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  res.json({
    success: true,
    count: data.length,
    lastUpdated: feedSyncAt,
    listings: data,
  });
};

module.exports = { getListings, getListing, getFeaturedListings };
