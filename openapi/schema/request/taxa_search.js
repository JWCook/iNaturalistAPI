const Joi = require( "joi" );

module.exports = Joi.object( ).keys( {
  q: Joi.string( ),
  is_active: Joi.boolean( ).default( true ),
  taxon_id: Joi.number( ).integer( ),
  parent_id: Joi.number( ).integer( ),
  rank: Joi.array( ).items( Joi.string( ).valid(
    "kingdom",
    "phylum",
    "subphylum",
    "superclass",
    "class",
    "subclass",
    "superorder",
    "order",
    "suborder",
    "infraorder",
    "superfamily",
    "epifamily",
    "family",
    "subfamily",
    "supertribe",
    "tribe",
    "subtribe",
    "genus",
    "genushybrid",
    "species",
    "hybrid",
    "subspecies",
    "variety",
    "form"
  ) ),
  rank_level: Joi.number( ).integer( ),
  id_above: Joi.number( ).integer( ),
  id_below: Joi.number( ).integer( ),
  per_page: Joi.number( ).integer( ),
  locale: Joi.string( ),
  preferred_place_id: Joi.number( ).integer( ),
  fields: Joi.any( )
} );
