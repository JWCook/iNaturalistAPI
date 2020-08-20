const ctrlv1 = require( "../v1/identifications_controller" );

const create = async req => {
  const response = await ctrlv1.create( req );
  return {
    page: 1,
    per_page: 1,
    total_results: 1,
    results: [response]
  };
};

const update = async req => {
  const { uuid } = req.params;
  req.params.id = uuid;
  const response = await ctrlv1.update( req );
  return {
    page: 1,
    per_page: 1,
    total_results: 1,
    results: [response]
  };
};

const destroy = async req => {
  const { uuid } = req.params;
  req.params.id = uuid;
  delete req.params.uuid;
  return ctrlv1.delete( req );
};

module.exports = {
  create,
  delete: destroy,
  identifiers: ctrlv1.identifiers,
  update
};
