const _ = require( "lodash" );
const fs = require( "fs" );
const request = require( "request" );
const path = require( "path" );
const squel = require( "squel" );
const md5 = require( "md5" );
const pgClient = require( "../../pg_client" );
const redisClient = require( "../../redis_client" );
const ObservationsController = require( "./observations_controller" );
const TaxaController = require( "./taxa_controller" );
const InaturalistAPI = require( "../../inaturalist_api" );
const config = require( "../../../config" );
const util = require( "../../util" );
const Taxon = require( "../../models/taxon" );
const FileCache = require( "../../vision/file_cache" );

// number of image results checked for common ancestor
const DEFAULT_ANCESTOR_WINDOW = 10;
// common ancestor score threshold
const DEFAULT_ANCESTOR_THRESHOLD = 75;
// common ancestor can be no higher than superfamily
const DEFAULT_ANCESTOR_RANK_LEVEL_CUTOFF = 33;

const TFServingTaxonDescendants = { };
const TFServingTaxonAncestries = { };

const cacheTaxonAncestries = ( taxonIDs, callback ) => {
  if ( _.isEmpty( taxonIDs ) ) {
    if ( callback ) { return void callback( null ); }
    return;
  }
  const query = squel.select( ).field( "id, ancestry" ).from( "taxa" )
    .where( "id IN ?", taxonIDs );
  pgClient.connection.query( query.toString( ), ( err, result ) => {
    if ( err ) {
      return void callback( );
    }
    _.each( result.rows, row => {
      const taxonID = row.id;
      if ( !row.ancestry ) { return; }
      const ancestors = row.ancestry.split( "/" );
      TFServingTaxonAncestries[taxonID] = ancestors;
      TFServingTaxonDescendants[taxonID] = TFServingTaxonDescendants[taxonID] || {};
      TFServingTaxonDescendants[taxonID][taxonID] = true;
      _.each( ancestors, ancestorID => {
        TFServingTaxonDescendants[ancestorID] = TFServingTaxonDescendants[ancestorID] || {};
        TFServingTaxonDescendants[ancestorID][taxonID] = true;
      } );
    } );
    if ( callback ) { callback( null ); }
  } );
};

if ( config.imageProcesing && config.imageProcesing.taxaFilePath
     && fs.existsSync( config.imageProcesing.taxaFilePath ) ) {
  const TFServingTaxonIDs = fs.readFileSync( config.imageProcesing.taxaFilePath )
    .toString( ).split( "\n" ).map( l => {
      const parts = l.split( ":" );
      return parts[1] ? Number( parts[1].trim( ) ) : 0;
    } );
  setTimeout( ( ) => {
    const idChunks = _.chunk( TFServingTaxonIDs, 500 );
    _.each( idChunks, taxonIDs => {
      cacheTaxonAncestries( taxonIDs );
    } );
  }, 2000 );
}

const ComputervisionController = class ComputervisionController {
  static scoreObservation( req, callback ) {
    if ( !req.userSession && !req.applicationSession ) {
      return void callback( { error: "Unauthorized", status: 401 } );
    }
    const obsID = Number( req.params.id );
    if ( !obsID ) {
      return void callback( { custom_message: "ID missing", status: 422 } );
    }
    const searchReq = { query: { id: obsID } };
    // fetch the obs metadata
    ObservationsController.search( searchReq, ( err, response ) => {
      if ( err ) { return void callback( err ); }
      if ( !response || _.isEmpty( response.results ) ) {
        return void callback( { custom_message: "Unknown observation" } );
      }
      const observation = response.results[0];
      let photoURL;
      _.each( observation.photos, p => {
        if ( photoURL ) { return; }
        if ( !p.url ) { return; }
        photoURL = p.url;
        if ( photoURL.match( /static\.inaturalist.*\/square\./i ) ) {
          photoURL = p.url.replace( "/square.", "/medium." );
        }
      } );
      if ( !photoURL ) {
        return void callback( { custom_message: "Observation has no scorable photos" } );
      }
      req.query.image_url = photoURL;
      ComputervisionController.scoreImageURL( req, { observation }, callback );
    } );
  }

  static scoreImageURL( req, options = { }, callback ) {
    if ( !req.userSession && !req.applicationSession ) {
      return void callback( { error: "Unauthorized", status: 401 } );
    }
    const photoURL = req.query.image_url;
    if ( !photoURL ) {
      return void callback( { custom_message: "No scorable photo", status: 422 } );
    }
    // download the JPG
    const parsedPhotoURL = path.parse( photoURL );
    const tmpFilename = `${md5( photoURL )}${parsedPhotoURL.ext.replace( /\?.+/, "" )}`;
    const tmpPath = path.resolve( global.config.imageProcesing.uploadsDir, tmpFilename );
    request( photoURL ).pipe( fs.createWriteStream( tmpPath ) ).on( "close", ( ) => {
      const scoreImageReq = Object.assign( req, {
        file: {
          filename: tmpFilename,
          mimetype: "image/jpeg",
          path: tmpPath
        }
      } );
      if ( !scoreImageReq.body ) { scoreImageReq.body = { }; }
      scoreImageReq.body.lat = scoreImageReq.body.lat || req.query.lat;
      scoreImageReq.body.lng = scoreImageReq.body.lng || req.query.lng;
      scoreImageReq.body.radius = scoreImageReq.body.radius || req.query.radius;
      scoreImageReq.body.taxon_id = scoreImageReq.body.taxon_id || req.query.taxon_id;
      if ( options.observation ) {
        scoreImageReq.body.observation_id = options.observation.id;
        if ( !scoreImageReq.body.lat && options.observation.location ) {
          const latLng = options.observation.location.split( "," );
          scoreImageReq.body.lat = latLng[0];
          scoreImageReq.body.lng = latLng[1];
        }
        if ( !scoreImageReq.body.observed_on && options.observation.observed_on ) {
          scoreImageReq.body.observed_on = options.observation.observed_on;
        }
        if ( !scoreImageReq.body.taxon_id
             && options.observation.taxon
             && options.observation.taxon.iconic_taxon_id ) {
          scoreImageReq.body.taxon_id = options.observation.taxon.iconic_taxon_id;
        }
      }
      // score the downloaded JPG
      ComputervisionController.scoreImage( scoreImageReq, callback );
    } );
  }

  static scoreImage( req, callback ) {
    if ( !req.userSession && !req.applicationSession ) {
      return void callback( { error: "Unauthorized", status: 401 } );
    }
    if ( !req.file ) {
      return void callback( { custom_message: "No image provided", status: 422 } );
    }
    ComputervisionController.scoreImageUpload( req.file.path, req, callback );
  }

  static scoreImagePath( uploadPath, req, callback ) {
    if ( req.inat && req.inat.visionCacheKey ) {
      const cachedScores = FileCache.cacheExists( req.inat.visionCacheKey );
      if ( cachedScores ) {
        return void callback( null, JSON.parse( cachedScores ) );
      }
    }
    const formData = {
      image: {
        value: fs.createReadStream( uploadPath ),
        options: {
          filename: req.file.filename,
          contentType: req.file.mimetype
        }
      }
    };
    const options = {
      url: config.imageProcesing.tensorappURL,
      timeout: 5000,
      formData
    };
    request.post( options, ( err, httpResponse, body ) => {
      if ( err ) { return void callback( err ); }
      let json;
      try {
        json = JSON.parse( body );
      } catch ( e ) {
        return void callback( { error: "Error scoring image", status: 500 } );
      }
      const counts = _.map( json, ( score, id ) => ( {
        taxon_id: Number( id ),
        count: score
      } ) );
      // replace inactive taxa with their active counterparts, remove remaining inactive
      TaxaController.replaceInactiveTaxaCounts( counts, { removeInactive: true },
        ( errr, updatedCounts, newTaxonIDs ) => {
          if ( errr ) { return void callback( errr ); }
          if ( req.inat && req.inat.visionCacheKey ) {
            FileCache.cacheFile( req.inat.visionCacheKey, JSON.stringify( updatedCounts ) );
          }
          // if there were taxa added to the counts to replace inactive taxa,
          // their ancestries need to be cached for fast common ancestor lookups.
          // Lookup only the taxa that haven't aleady been cached
          const newIDsToCache = _.filter( newTaxonIDs,
            taxonID => _.isEmpty( TFServingTaxonAncestries[taxonID] ) );
          cacheTaxonAncestries( newIDsToCache, ( ) => {
            callback( null, updatedCounts );
          } );
        } );
    } );
  }

  static scoreImageUpload( uploadPath, req, callback ) {
    InaturalistAPI.setPerPage( req, { default: 10, max: 100 } );
    ComputervisionController.scoreImagePath( uploadPath, req, ( err, imageScores ) => {
      if ( err ) { return void callback( err ); }
      let scores = _.filter( imageScores, s => ( s.count > 0 ) );
      if ( req.body.taxon_id ) {
        if ( !TFServingTaxonDescendants[req.body.taxon_id] ) {
          return void InaturalistAPI.basicResponse( null, req, null, callback );
        }
        scores = _.filter( scores, s => TFServingTaxonDescendants[req.body.taxon_id][s.taxon_id] );
      }
      scores = _.sortBy( scores, "count" ).reverse( );
      ComputervisionController.normalizeScores( scores );
      ComputervisionController.commonAncestor( req, scores, ( errr, commonAncestor ) => {
        if ( errr ) { return void callback( errr ); }
        let frequencyFunction;
        // if the redis client is configured and the app is configured to,
        // or the request asks for it, query Redis for frequency data
        if ( !_.isEmpty( redisClient )
          && ( req.body.redis_frequencies === "true" || config.imageProcesing.frequencyBackend === "redis" ) ) {
          frequencyFunction = ComputervisionController.nearbyTaxonFrequenciesRedis;
        } else {
          // otherwise query Elasticsearch for frequency data
          frequencyFunction = ComputervisionController.nearbyTaxonFrequencies;
        }
        frequencyFunction(
          req, scores, commonAncestor, ( errrr, nearbyTaxa ) => {
            if ( errrr ) { return void callback( errrr ); }
            ComputervisionController.scoreImageAfterFrequencies(
              req, scores, nearbyTaxa, commonAncestor, callback
            );
          }
        );
      } );
    } );
  }

  // Combine vision scores with nearby observation frequencies
  static scoreImageAfterFrequencies( req, rawVisionScores, nearbyTaxa, commonAncestor, callback ) {
    // using _.has just checks to see results is an attribute of nearbyTaxa,
    // it would still be true if there were no nearby results, in which case
    // there would be no results at all
    if ( nearbyTaxa && _.has( nearbyTaxa, "results" ) ) {
      const ancestorNearbyTaxaResults = [];
      const unrelatedNearbyTaxaResults = [];
      const relatedNearbyTaxa = { };
      const unrelatedNearbyTaxa = { };
      const frequencyScores = { };
      const visionScores = { };
      const combinedScores = { };
      let topScores;
      // set frequencyScores and mark if nearby taxon is related to common ancestor
      _.each( nearbyTaxa.results, r => {
        if ( commonAncestor && r.taxon
             && r.taxon.ancestor_ids.includes( commonAncestor.taxon.id ) ) {
          r.inCommonAncestor = true;
          relatedNearbyTaxa[r.taxon.id] = true;
          ancestorNearbyTaxaResults.push( r );
        } else if ( r.taxon ) {
          unrelatedNearbyTaxa[r.taxon.id] = true;
          unrelatedNearbyTaxaResults.push( r );
        }
        const numObs = r.count;
        frequencyScores[r.taxon.id] = numObs;
      } );
      // only boost vision:
      //   a) given a common ancestor, using nearby taxa in that ancestor
      //   b) there are no common ancestors, using all nearby taxa
      const resultsToUse = commonAncestor ? ancestorNearbyTaxaResults : unrelatedNearbyTaxaResults;
      // First, we're going to add nearby taxa to the combined scores
      const sumScoresResultsToUse = _.reduce( resultsToUse,
        ( sum, r ) => ( sum + r.count ), 0 );
      // Scale observation frequencies to a 0-1 range as a ratio of the obs
      // count to the count of all obs of nearby taxa we're assessing
      _.each( resultsToUse, r => {
        const numObs = r.count;
        const score = ( numObs / sumScoresResultsToUse );
        // Default score for non-model nearby taxa is a modified frequency
        // score. We multiple by 0.75 to accommodate situations where there's
        // only one nearby taxon and it's not in the vision results. That would
        // mean that its score at this point is 1, which isn't comporable to the
        // vision scores (they're always between 0 and 1), so we downplay all
        // nearby scores by default, and a taxon that is the only one with
        // nearby observations will get a score of 0.75
        combinedScores[r.taxon.id] = score * 0.75;
      } );
      // Next, we'll add taxa from vision
      if ( !_.isEmpty( redisClient )
        && ( req.body.redis_frequencies === "true" || config.imageProcesing.frequencyBackend === "redis" ) ) {
        _.each( rawVisionScores, r => {
          const rawVisionScore = r.count;
          visionScores[r.taxon_id] = rawVisionScore;
          const combinedScore = combinedScores[r.taxon_id];
          if ( combinedScore ) {
            // Vision results with relevant frequency scores get a boost.
            // Here we know this taxon was in both vision and nearby taxa, so we
            // don't need to worry about a single nearby taxon that's not in
            // vision overwhelming other vision results, so we remove that 0.75
            // modification.
            const unmodifiedObsScore = combinedScore / 0.75;
            // We fasted, chanted, and sacrificed for many days until a demon
            // appeared in the night and spake unto us, "multiply by 6 and add
            // 3"
            combinedScores[r.taxon_id] = rawVisionScore * ( 3 + ( unmodifiedObsScore * 6 ) );
          } else {
            // everything else uses the raw vision score
            combinedScores[r.taxon_id] = rawVisionScore;
          }
        } );
        topScores = _.map( combinedScores, ( v, k ) => (
          {
            taxon_id: k,
            count: req.body.frequency_only_remove === "true" ? ( visionScores[k] || 0 ) : v,
            frequency_score: ( frequencyScores[k] || 0 ),
            vision_score: ( visionScores[k] || 0 )
          }
        ) );
      } else {
        // This non-redis algorithm isn't really used and is pretty much
        // vestigial at this point
        _.each( rawVisionScores, r => {
          const rawVisionScore = r.count;
          visionScores[r.taxon_id] = rawVisionScore;
          // the ( ... || 1 ) prevents dividing by 0
          if ( combinedScores[r.taxon_id] ) {
            combinedScores[r.taxon_id] *= ( rawVisionScore / 100 );
          } else {
            combinedScores[r.taxon_id] = ( rawVisionScore / 100 )
              * ( 1 / ( ( ancestorNearbyTaxaResults.length || 1 ) * 100 ) );
          }
        } );
        topScores = _.map( combinedScores, ( combinedScore, taxonID ) => {
          let finalScore;
          if ( req.body.frequency_only_remove === "true" ) {
            finalScore = visionScores[taxonID] || 0;
          } else {
            finalScore = visionScores[taxonID]
              ? combinedScore
              : combinedScore * ( 1 / rawVisionScores.length );
          }
          return {
            taxon_id: taxonID,
            count: finalScore,
            frequency_score: ( frequencyScores[taxonID] || 0 ) * 100,
            vision_score: ( visionScores[taxonID] || 0 )
          };
        } );
      }
      if ( req.body.must_be_in_frequency === "true" || req.body.frequency_only_remove === "true" ) {
        topScores = _.filter( topScores, s => frequencyScores[s.taxon_id] );
      }
      if ( req.body.must_be_in_vision === "true" ) {
        topScores = _.filter( topScores, s => s.vision_score > 0 );
      }
      topScores = _.sortBy( topScores, s => s.count ).reverse( );
      ComputervisionController.normalizeScores( topScores );
      ComputervisionController.scoreImageResponse(
        req, commonAncestor, topScores.slice( 0, req.query.per_page ), callback
      );
    } else {
      const top10 = rawVisionScores.slice( 0, req.query.per_page );
      _.each( top10, s => { s.vision_score = s.count; } );
      ComputervisionController.scoreImageResponse( req, commonAncestor, top10, callback );
    }
  }

  static scoreImageResponse( req, commonAncestor, top10, callback ) {
    if ( req.inat.visionStats ) {
      return void callback( null, { results: top10, common_ancestor: commonAncestor } );
    }
    req.inat.taxonPhotos = true;
    req.inat.taxonAncestries = true;
    TaxaController.speciesCountsResponse( req, top10, { }, ( err, response ) => {
      if ( err ) { return void callback( err ); }
      _.each( response.results, r => {
        r.combined_score = r.count;
        delete r.count;
      } );
      // there is no common ancestor, or its a blacklisted taxon
      if ( !commonAncestor || !commonAncestor.taxon
        || ( Taxon.homo && commonAncestor.taxon.id === Taxon.homo.id ) ) {
        return void callback( null, response );
      }
      // If we have a common ancestor, we need to reload it b/c it might have
      // been derived from an ancestor that doesn't have all its properties,
      // like names
      Taxon.findByID( commonAncestor.taxon.id, ( errr, taxon ) => {
        if ( errr ) { return void callback( errr ); }
        commonAncestor.taxon = new Taxon( taxon );
        const localeOpts = util.localeOpts( req );
        const options = { localeOpts };
        commonAncestor.taxon.prepareForResponse( localeOpts, options );
        response.common_ancestor = commonAncestor;
        callback( null, response );
      } );
    } );
  }

  static commonAncestor( req, scores, callback ) {
    if ( req.body.skip_frequencies === "true" ) {
      return void callback( );
    }
    const topScores = _.cloneDeep( scores )
      .slice( 0, req.body.ancestor_window || DEFAULT_ANCESTOR_WINDOW );
    const speciesCountsReq = {
      query: Object.assign( { }, req.query, { per_page: topScores.length } ),
      inat: Object.assign( { }, req.inat, {
        taxonPhotos: true,
        taxonAncestries: true
      } )
    };
    ComputervisionController.normalizeScores( topScores );
    ComputervisionController.addTaxa( speciesCountsReq, topScores, ( err, results ) => {
      if ( err ) { return void callback( err ); }
      _.each( results, r => {
        r.vision_score = r.count;
        delete r.count;
      } );
      const commonAncestor = ComputervisionController.commonAncestorByScore(
        results, req.body.ancestor_threshold || DEFAULT_ANCESTOR_THRESHOLD
      );
      if ( commonAncestor && commonAncestor.taxon.rank_level <= (
        req.body.rank_level_cutoff || DEFAULT_ANCESTOR_RANK_LEVEL_CUTOFF ) ) {
        return void callback( null, commonAncestor );
      }
      callback( );
    } );
  }

  // turn { count: C, taxon_id: TID }
  // into { count: C, taxon: T }
  static addTaxa( speciesCountsReq, scores, callback ) {
    if ( !speciesCountsReq.inat.visionCacheKey ) {
      TaxaController.speciesCountsResponse( speciesCountsReq, _.cloneDeep( scores ), { }, ( err, response ) => {
        if ( err ) { return void callback( err ); }
        callback( null, response.results );
      } );
      return;
    }
    const scoresWithCachedTaxa = [];
    const scoresToLookup = [];
    // determine which are cached and which need to be looked up
    _.each( _.cloneDeep( scores ), score => {
      const taxonCacheKey = `taxon_${score.taxon_id}`;
      const cachedTaxon = FileCache.cacheExists( taxonCacheKey );
      if ( !_.isEmpty( cachedTaxon ) ) {
        const withTaxon = Object.assign( { }, score, { taxon: JSON.parse( cachedTaxon ) } );
        delete withTaxon.taxon_id;
        scoresWithCachedTaxa.push( withTaxon );
      } else {
        scoresToLookup.push( score );
      }
    } );
    // if everything is cached, return the sorted cached taxa
    if ( scoresToLookup.length === 0 ) {
      return void callback( null, _.sortBy( scoresWithCachedTaxa, "count" ).reverse( ) );
    }
    // lookup the remaining and merge them with the cached taxa
    TaxaController.speciesCountsResponse( speciesCountsReq, scoresToLookup, { },
      ( err, response ) => {
        if ( err ) { return void callback( err ); }
        _.each( response.results, r => {
          const taxonCacheKey = `taxon_${r.taxon.id}`;
          FileCache.cacheFile( taxonCacheKey, JSON.stringify( r.taxon ) );
        } );
        const combinedResults = scoresWithCachedTaxa.concat( response.results );
        callback( null, _.sortBy( combinedResults, "count" ).reverse( ) );
      } );
  }


  static commonAncestorByScore( results, threshold ) {
    const roots = { };
    const children = { };
    const ancestorCounts = { };
    _.each( results, r => {
      let lastTaxon;
      if ( r.taxon.ancestors ) {
        _.each( r.taxon.ancestors.concat( [r.taxon] ), ( t, index ) => {
          if ( index === 0 ) {
            roots[t.id] = t;
          } else {
            children[lastTaxon.id] = children[lastTaxon.id] || { };
            children[lastTaxon.id][t.id] = t;
          }
          ancestorCounts[t.id] = ancestorCounts[t.id] || 0;
          ancestorCounts[t.id] += r.vision_score;
          lastTaxon = t;
        } );
      }
    } );
    const commonAncestor = ComputervisionController.commonAncestorByScoreSub(
      null, roots, children, ancestorCounts, threshold
    );
    if ( !commonAncestor ) { return null; }
    return {
      taxon: commonAncestor,
      score: ancestorCounts[commonAncestor.id]
    };
  }

  static commonAncestorByScoreSub( taxon, roots, children, ancestorCounts, threshold ) {
    if ( taxon && taxon.rank === "genus" ) { return taxon; }
    let commonAncestor = taxon;
    const iterationTaxa = taxon ? children[taxon.id] : roots;
    const sorted = _.sortBy( iterationTaxa, t => ( ancestorCounts[t.id] ) ).reverse( );
    _.each( sorted, ( t, index ) => {
      if ( !taxon && index !== 0 ) { return; }
      if ( ancestorCounts[t.id] < threshold ) { return; }
      commonAncestor = ComputervisionController.commonAncestorByScoreSub(
        t, roots, children, ancestorCounts, threshold
      );
    } );
    return commonAncestor;
  }

  // this is not being used right now
  static nearbyTaxonFrequenciesDB( req, scores, commonAncestor, callback ) {
    if ( !scores || !req.body.lat || !req.body.lng || req.body.skip_frequencies === "true" ) {
      return void callback( null, null );
    }
    const taxonIDs = _.map( scores, "taxon_id" );
    let swlat = Math.floor( req.body.lat - 0.5 );
    let swlng = Math.floor( req.body.lng - 0.5 );
    if ( swlat < -90 ) { swlat = -90; }
    if ( swlng < -180 ) { swlng = -180; }
    if ( swlat > 88 ) { swlat = 88; }
    if ( swlng > 178 ) { swlng = 178; }
    let subquery = squel.select( )
      .field( "fct.taxon_id, fct.count" )
      .from( "frequency_cells fc" )
      .join( "frequency_cell_month_taxa fct", null, "fc.id = fct.frequency_cell_id" )
      .join( "taxa t", null, "fct.taxon_id = t.id" )
      .where( "fc.swlat BETWEEN ? AND ?", swlat, swlat + 2 )
      .where( "fc.swlng BETWEEN ? AND ?", swlng, swlng + 2 );
    if ( commonAncestor ) {
      subquery = subquery.where(
        "fct.taxon_id IN ? OR t.ancestry LIKE '%/?/%' OR t.ancestry LIKE '%/?'",
        taxonIDs, commonAncestor.taxon.id, commonAncestor.taxon.id
      );
    } else {
      subquery = subquery.where( "fct.taxon_id IN ?", taxonIDs );
    }
    if ( req.body.observed_on ) {
      const parsedDate = util.parsedDateParam( req.body.observed_on );
      if ( parsedDate && parsedDate.isValid( ) ) {
        // 0 is January
        const dateMonth = parsedDate.month( );
        const monthBefore = ( dateMonth - 1 ) % 12;
        const monthAfter = ( dateMonth + 1 ) % 12;
        subquery = subquery.where( "fct.month IN ?", [monthBefore + 1, dateMonth + 1, monthAfter + 1] );
      }
    }
    const query = squel.select( )
      .field( "taxon_id, count, ancestry" )
      .from( `(${subquery.toString( )}) as subq` )
      .join( "taxa t on (taxon_id=t.id)" );
    pgClient.connection.query( query.toString( ), ( err, result ) => {
      if ( err ) {
        return void callback( );
      }
      const taxaCounts = { };
      _.each( result.rows, r => {
        taxaCounts[r.taxon_id] = taxaCounts[r.taxon_id] || { ancestry: r.ancestry, count: 0 };
        taxaCounts[r.taxon_id].count += Number( r.count );
      } );
      callback( null, {
        results: _.map( taxaCounts, ( data, taxonID ) => ( {
          taxon_id: taxonID,
          count: data.count,
          taxon: {
            id: taxonID,
            ancestor_ids: _.map( data.ancestry.split( "/" ), a => Number( a ) )
          }
        } ) )
      } );
    } );
  }

  static nearbyTaxonFrequenciesRedis( req, scores, commonAncestor, callback ) {
    if ( !scores || !req.body.lat || !req.body.lng || req.body.skip_frequencies === "true" ) {
      return void callback( null, null );
    }
    const includeTaxonIDs = _.map( scores, "taxon_id" );
    const nearbyReq = {
      inat: { includeTaxonIDs },
      query: {
        lat: req.body.lat,
        lng: req.body.lng,
        observed_on: req.body.observed_on
      }
    };
    if ( commonAncestor ) {
      nearbyReq.query.taxon_id = commonAncestor.taxon.id;
    }
    TaxaController.nearby( nearbyReq, ( err, response ) => {
      if ( err ) { return void callback( err ); }
      const { results } = response;
      // normalize raw taxon counts into a ratio of all counts
      ComputervisionController.normalizeScores( results );
      callback( null, { results } );
    } );
  }

  static nearbyTaxonFrequencies( req, scores, commonAncestor, callback ) {
    if ( !scores || !req.body.lat || !req.body.lng || req.body.skip_frequencies === "true" ) {
      return void callback( null, null );
    }
    let taxonIDs = [];
    if ( commonAncestor ) {
      taxonIDs.push( commonAncestor.taxon.id );
    }
    taxonIDs = taxonIDs.concat( _.map( scores, "taxon_id" ) );
    const query = {
      quality_grade: "research",
      taxon_is_active: "true",
      taxon_id: taxonIDs,
      lat: req.body.lat,
      lng: req.body.lng,
      radius: req.body.radius || 100 // km
    };
    if ( req.body.observation_id ) {
      query.not_id = req.body.observation_id;
    }
    if ( req.body.observed_on ) {
      const parsedDate = util.parsedDateParam( req.body.observed_on );
      if ( parsedDate && parsedDate.isValid( ) ) {
        query.observed_after = parsedDate.subtract( req.body.window || 45, "days" )
          .format( "YYYY-MM-DDTHH:mm:ss" );
        query.observed_before = parsedDate.add( req.body.window || 45, "days" )
          .format( "YYYY-MM-DDTHH:mm:ss" );
      }
    }
    ObservationsController.speciesCounts( { query }, ( err, response ) => {
      if ( err ) { return void callback( err ); }
      callback( null, response );
    } );
  }

  static normalizeScores( scores, multiplier = 100 ) {
    const sumScores = _.sum( _.map( scores, "count" ) );
    _.each( scores, r => {
      r.count = ( ( r.count * multiplier ) / sumScores );
    } );
  }

  static modelContainsTaxonID( taxonID ) {
    return !!TFServingTaxonAncestries[taxonID];
  }
};

module.exports = ComputervisionController;
