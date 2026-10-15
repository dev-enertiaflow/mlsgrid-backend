const supabase = require('../config/supabase');
const cloudinary = require('../config/cloudinary');

const OFFICE_ID = 'MFR771620';
const ORIGINATING_SYSTEM = 'mfrmls';
const PAGE_SIZE = 15; // 15 listings per page (~6 mins per batch, avoids 1-hour media URL expiration)
const REQUEST_DELAY_MS = 600; // Between MLS Grid replication calls (< 2 RPS)
const MEDIA_DELAY_MS = 1000; // 1 second between photo downloads (1 RPS)

function buildPropertyUrl({ modificationTimestamp = null, top = PAGE_SIZE } = {}) {
  let filter = `OriginatingSystemName eq '${ORIGINATING_SYSTEM}' and ListOfficeMlsId eq '${OFFICE_ID}' and StandardStatus eq 'Active' and MlgCanView eq true`;
  if (modificationTimestamp) {
    const isoTs = new Date(modificationTimestamp).toISOString();
    filter += ` and ModificationTimestamp gt ${isoTs}`;
  }
  return `https://api.mlsgrid.com/v2/Property?$filter=${filter}&$top=${top}&$expand=Media`;
}

const MLS_TEST_URL = buildPropertyUrl({ top: 1 });

/**
 * Downloads media from MLS Grid and streams buffer directly into Cloudinary with optimal compression.
 * Smart cache: Reuses existing Cloudinary URLs if the photo's MediaKey and MediaModificationTimestamp
 * have not changed in Supabase. Only downloads genuinely new/updated photos.
 */
async function uploadMediaToCloudinary(listing) {
  if (!listing.Media?.length) {
    return { listing, uploadedCount: 0, skippedCount: 0 };
  }

  const updated = JSON.parse(JSON.stringify(listing));
  const listingKey = listing.ListingKey;

  // 1. Check if this listing already exists in Supabase with cached Cloudinary media
  const existingMediaMap = new Map();
  try {
    const { data: existingRow } = await supabase
      .from('listings')
      .select('raw_data')
      .eq('listing_key', listingKey)
      .maybeSingle();

    if (existingRow?.raw_data?.Media) {
      existingRow.raw_data.Media.forEach((m) => {
        if (m.MediaKey && m.MediaURL && m.MediaURL.includes('cloudinary.com')) {
          existingMediaMap.set(m.MediaKey, m);
        }
      });
    }
  } catch (lookupErr) {
    console.warn(`[Media] ⚠️ Could not read existing media for ${listingKey}: ${lookupErr.message}`);
  }

  let uploadedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < updated.Media.length; i++) {
    const item = updated.Media[i];
    const orderStr = String(item.Order ?? i).padStart(2, '0');
    const mediaKey = item.MediaKey || `img_${orderStr}`;
    const publicId = `mls_listings/${listingKey}/${orderStr}_${mediaKey}`;

    // A. Skip if already converted to a Cloudinary URL
    if (item.MediaURL && item.MediaURL.includes('cloudinary.com')) {
      skippedCount++;
      continue;
    }

    // B. Smart Cache: Check if photo exists in Supabase with matching timestamp
    if (existingMediaMap.has(mediaKey)) {
      const cached = existingMediaMap.get(mediaKey);
      const isSameTimestamp = !item.MediaModificationTimestamp ||
        !cached.MediaModificationTimestamp ||
        item.MediaModificationTimestamp === cached.MediaModificationTimestamp;

      if (isSameTimestamp && cached.MediaURL) {
        item.MediaURL = cached.MediaURL;
        item.CloudinaryPublicId = cached.CloudinaryPublicId || publicId;
        skippedCount++;
        continue;
      }
    }

    // C. Photo is genuinely brand new or updated by the agent! Download from MLS Grid
    console.log(`[Media] 📥 Downloading new photo [${orderStr}] (MediaKey: ${mediaKey}) for ${listingKey}...`);

    try {
      // Fetch signed MLS Grid image URL
      const res = await fetch(item.MediaURL, {
        headers: {
          'Accept-Encoding': 'gzip,deflate',
        },
      });

      // Handle 429 rate limit backoff safely
      if (res.status === 429) {
        console.warn(`[429 Rate Limit] Pausing 60s before retrying photo ${orderStr}...`);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        i--;
        continue;
      }

      if (!res.ok) {
        console.warn(`[Media] Skipping photo [${orderStr}] (${item.MediaURL}): HTTP ${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, MEDIA_DELAY_MS));
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // Stream directly to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `mls_listings/${listingKey}`,
            asset_folder: `mls_listings/${listingKey}`,
            public_id: `${orderStr}_${mediaKey}`,
            use_asset_folder_as_public_id_prefix: true,
            overwrite: true,
            resource_type: 'image',
            tags: [listingKey, listing.ListOfficeMlsId, listing.ListAgentMlsId].filter(Boolean),
            transformation: [{ quality: 'auto', fetch_format: 'auto' }],
          },
          (err, result) => {
            if (err) return reject(err);
            resolve(result);
          }
        );
        stream.end(buffer);
      });

      item.MediaURL = uploadResult.secure_url;
      item.CloudinaryPublicId = publicId;
      uploadedCount++;
      console.log(`[Media] ✅ Uploaded [${orderStr}/${updated.Media.length}] to Cloudinary: ${uploadResult.secure_url}`);
    } catch (err) {
      console.warn(`[Media] ⚠️ Upload failed for photo [${orderStr}]: ${err.message}`);
    }

    // Rate-limit throttle (1 RPS)
    await new Promise((resolve) => setTimeout(resolve, MEDIA_DELAY_MS));
  }

  if (skippedCount > 0) {
    console.log(`[Media] ⚡ ${listingKey}: Reused ${skippedCount} existing Cloudinary photos (0 downloads from MLS Grid).`);
  }
  if (uploadedCount > 0) {
    console.log(`[Media] 📸 ${listingKey}: Uploaded ${uploadedCount} new/updated photos to Cloudinary.`);
  }

  return { listing: updated, uploadedCount, skippedCount };
}

/**
 * Upserts listing record into Supabase listings table
 */
async function upsertListing(listing) {
  const payload = {
    listing_key: listing.ListingKey,
    office_mls_id: listing.ListOfficeMlsId,
    agent_mls_id: listing.ListAgentMlsId || null,
    modification_timestamp: listing.ModificationTimestamp || null,
    mlg_can_view: listing.MlgCanView ?? true,
    list_price: listing.ListPrice || null,
    standard_status: listing.StandardStatus || null,
    city: listing.City || null,
    postal_code: listing.PostalCode || null,
    bedrooms_total: listing.BedroomsTotal || null,
    bathrooms_total: listing.BathroomsTotalInteger || null,
    property_type: listing.PropertyType || null,
    living_area: listing.LivingArea || null,
    raw_data: listing,
  };

  const { data: existing } = await supabase
    .from('listings')
    .select('listing_key')
    .eq('listing_key', listing.ListingKey)
    .maybeSingle();

  const { error } = await supabase
    .from('listings')
    .upsert(payload, { onConflict: 'listing_key' });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  return existing ? 'updated' : 'inserted';
}

/**
 * Fetches the greatest ModificationTimestamp already stored for this office.
 */
async function getGreatestModificationTimestamp() {
  const { data, error } = await supabase
    .from('listings')
    .select('modification_timestamp')
    .eq('office_mls_id', OFFICE_ID)
    .order('modification_timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.modification_timestamp;
}

/**
 * Test function: Syncs exactly 1 active listing for Paul Mercer's office
 */
async function syncTestListing() {
  console.log(`Fetching 1 test listing for Office ${OFFICE_ID}...`);
  const res = await fetch(MLS_TEST_URL, {
    headers: {
      Authorization: `Bearer ${process.env.MLS_GRID_TOKEN}`,
      'Accept-Encoding': 'gzip,deflate',
    },
  });

  if (!res.ok) {
    throw new Error(`MLS Grid API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const raw = json.value?.[0];

  if (!raw) {
    console.log('No listings returned from MLS Grid.');
    return;
  }

  console.log(`\nFetched listing: ${raw.ListingKey} (${raw.ListingId})`);
  console.log(`Agent: ${raw.ListAgentFullName} (${raw.ListAgentMlsId})`);
  console.log(`Office: ${raw.ListOfficeName} (${raw.ListOfficeMlsId})`);
  console.log(`Price: $${raw.ListPrice?.toLocaleString?.() || raw.ListPrice}`);
  console.log(`Address: ${raw.UnparsedAddress || `${raw.StreetNumber || ''} ${raw.StreetName || ''}`}`);
  console.log(`Total Media Items: ${raw.Media?.length || 0}\n`);

  const { listing, uploadedCount } = await uploadMediaToCloudinary(raw);

  const action = await upsertListing(listing);
  console.log(`\nSuccessfully ${action} test listing into Supabase!`);
  console.log(`ListingKey: ${listing.ListingKey}`);
  console.log(`Photos uploaded to Cloudinary: ${uploadedCount}`);
  if (listing.Media?.length) {
    console.log(`Sample Cloudinary URL: ${listing.Media[0].MediaURL}`);
  }
  return listing;
}

/**
 * Full sync: Pages through all office listings in batches of 15 ($top=15).
 * Supports resume mode and optional limit (e.g. limit: 50).
 */
async function syncAllListings({ resume = false, limit = null } = {}) {
  let nextUrl = null;

  if (resume) {
    const lastTs = await getGreatestModificationTimestamp();
    if (lastTs) {
      console.log(`Resuming from ModificationTimestamp: ${lastTs}`);
      nextUrl = buildPropertyUrl({ modificationTimestamp: lastTs });
    } else {
      nextUrl = buildPropertyUrl();
    }
  } else {
    nextUrl = buildPropertyUrl();
  }

  let page = 0;
  let totalSynced = 0;
  let greatestTs = null;

  while (nextUrl) {
    page++;
    console.log(`\n========================================`);
    console.log(`--- Processing Batch Page ${page} ---`);
    console.log(`Fetching: ${nextUrl}`);
    console.log(`========================================`);

    let json;
    try {
      const res = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${process.env.MLS_GRID_TOKEN}`,
          'Accept-Encoding': 'gzip,deflate',
        },
      });

      if (!res.ok) {
        throw new Error(`MLS Grid API error: ${res.status} ${res.statusText}`);
      }

      json = await res.json();
    } catch (err) {
      console.error(`\nFetch error on page ${page}: ${err.message}`);
      if (greatestTs) {
        console.error(
          `To resume, run with --resume flag. Greatest ModificationTimestamp saved: ${greatestTs}`
        );
      }
      break;
    }

    const listings = json.value || [];
    console.log(`Received ${listings.length} listings in this batch\n`);

    if (listings.length === 0) break;

    let batchPhotosUploaded = 0;
    let batchPhotosSkipped = 0;
    let batchListingsSynced = 0;

    for (const raw of listings) {
      try {
        if (
          raw.ModificationTimestamp &&
          (!greatestTs || raw.ModificationTimestamp > greatestTs)
        ) {
          greatestTs = raw.ModificationTimestamp;
        }

        // Handle deletion or non-active status
        if (raw.MlgCanView === false || raw.StandardStatus !== 'Active') {
          await supabase
            .from('listings')
            .delete()
            .eq('listing_key', raw.ListingKey);
          try {
            await cloudinary.api.delete_resources_by_prefix(`mls_listings/${raw.ListingKey}/`);
          } catch (_) {}
          console.log(`Removed inactive listing: ${raw.ListingKey}`);
          continue;
        }

        // Deduplication: If already in DB with Cloudinary URLs, skip downloading again
        const { data: existingListing } = await supabase
          .from('listings')
          .select('listing_key, raw_data')
          .eq('listing_key', raw.ListingKey)
          .maybeSingle();

        let listing = raw;
        if (
          existingListing?.raw_data?.Media?.length &&
          existingListing.raw_data.Media.every((m) => m.MediaURL?.includes('cloudinary.com'))
        ) {
          console.log(`[Already in Cloudinary] Skipping photo re-download for ${raw.ListingKey}`);
          listing = existingListing.raw_data;
          batchPhotosSkipped += (existingListing.raw_data.Media.length || 0);
        } else {
          console.log(`\nProcessing [${raw.ListingKey}] - ${raw.UnparsedAddress || 'No Address'}`);
          const resMedia = await uploadMediaToCloudinary(raw);
          listing = resMedia.listing;
          batchPhotosUploaded += resMedia.uploadedCount;
          batchPhotosSkipped += resMedia.skippedCount;
        }

        const action = await upsertListing(listing);
        totalSynced++;
        batchListingsSynced++;
        console.log(`Synced [${totalSynced}${limit ? `/${limit}` : ''}] ${action}: ${listing.ListingKey}`);

        if (limit && totalSynced >= limit) {
          console.log(`\n========================================`);
          console.log(`📊 BATCH SUMMARY (Target of ${limit} Reached)`);
          console.log(`========================================`);
          console.log(`• Listings Synced: ${totalSynced} / ${limit}`);
          console.log(`• Photos Uploaded to Cloudinary: ${batchPhotosUploaded}`);
          console.log(`• Photos Reused / Cached: ${batchPhotosSkipped}`);
          console.log(`• Resume Timestamp: ${greatestTs}`);
          console.log(`========================================\n`);
          return { totalSynced, greatestTs, batchPhotosUploaded, batchPhotosSkipped };
        }
      } catch (err) {
        console.warn(`Failed to sync ${raw.ListingKey}: ${err.message}`);
      }
    }

    console.log(`\n========================================`);
    console.log(`📊 BATCH SUMMARY (Page ${page})`);
    console.log(`========================================`);
    console.log(`• Listings in Batch: ${batchListingsSynced} / ${listings.length}`);
    console.log(`• Photos Uploaded to Cloudinary: ${batchPhotosUploaded}`);
    console.log(`• Photos Reused / Cached: ${batchPhotosSkipped}`);
    console.log(`• Total Synced So Far: ${totalSynced}${limit ? ` / ${limit}` : ''}`);
    console.log(`• Resume Timestamp: ${greatestTs}`);
    console.log(`========================================\n`);

    nextUrl = json['@odata.nextLink'] || null;

    if (nextUrl) {
      console.log(`Waiting ${REQUEST_DELAY_MS}ms before requesting next batch...`);
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
  }

  console.log(`\nSync complete. Total listings synced: ${totalSynced}`);
  return { totalSynced, greatestTs };
}

/**
 * Incremental sync: only pulls changes since greatest ModificationTimestamp
 */
async function incrementalSync() {
  const lastTs = await getGreatestModificationTimestamp();

  if (!lastTs) {
    console.log('[incrementalSync] No existing records found, running full sync instead.');
    return syncAllListings();
  }

  const url = buildPropertyUrl({ modificationTimestamp: lastTs });
  console.log(`[incrementalSync] Pulling changes since: ${lastTs}`);

  let nextUrl = url;
  let page = 0;
  let totalSynced = 0;
  let totalDeleted = 0;
  let greatestTs = lastTs;

  while (nextUrl) {
    page++;

    let json;
    try {
      const res = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${process.env.MLS_GRID_TOKEN}`,
          'Accept-Encoding': 'gzip,deflate',
        },
      });

      if (!res.ok) throw new Error(`MLS Grid API error: ${res.status} ${res.statusText}`);
      json = await res.json();
    } catch (err) {
      console.error(`[incrementalSync] Fetch error on page ${page}: ${err.message}`);
      break;
    }

    const listings = json.value || [];
    console.log(`[incrementalSync] Page ${page}: ${listings.length} records`);

    if (listings.length === 0) break;

    for (const raw of listings) {
      try {
        if (raw.ModificationTimestamp && raw.ModificationTimestamp > greatestTs) {
          greatestTs = raw.ModificationTimestamp;
        }

        if (raw.MlgCanView === false || raw.StandardStatus !== 'Active') {
          const { error } = await supabase
            .from('listings')
            .delete()
            .eq('listing_key', raw.ListingKey);
          if (!error) {
            totalDeleted++;
            try {
              await cloudinary.api.delete_resources_by_prefix(`mls_listings/${raw.ListingKey}/`);
            } catch (_) {}
            console.log(`[incrementalSync] Deleted: ${raw.ListingKey}`);
          }
          continue;
        }

        const { listing, uploadedCount, skippedCount } = await uploadMediaToCloudinary(raw);
        const action = await upsertListing(listing);
        totalSynced++;
        console.log(`[incrementalSync] ✅ ${action.toUpperCase()}: ${raw.ListingKey} ($${Number(raw.ListPrice || 0).toLocaleString()} | ${raw.City || 'Unknown'}) [Photos: ${skippedCount} cached, ${uploadedCount} new]`);
      } catch (err) {
        console.warn(`[incrementalSync] ❌ Failed on ${raw.ListingKey}: ${err.message}`);
      }
    }

    nextUrl = json['@odata.nextLink'] || null;
    if (nextUrl) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
  }

  return { totalSynced, totalDeleted, greatestTs };
}

module.exports = { syncTestListing, syncAllListings, incrementalSync };
