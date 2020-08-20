const j2s = require( "hapi-joi-to-swagger" );
const IdentificationsController = require( "../../../lib/controllers/v2/identifications_controller" );
const identificationsCreateSchema = require( "../../schema/request/identifications_create" );

module.exports = sendWrapper => {
  async function POST( req, res ) {
    const results = await IdentificationsController.create( req );
    sendWrapper( req, res, null, results );
  }

  POST.apiDoc = {
    tags: ["Identifications"],
    summary: "Create an identification",
    security: [{
      jwtRequired: []
    }],
    requestBody: {
      content: {
        "multipart/form-data": {
          schema: j2s( identificationsCreateSchema ).swagger
        },
        "application/json": {
          schema: j2s( identificationsCreateSchema ).swagger
        }
      }
    },
    responses: {
      200: {
        description: "A list of identifications",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ResultsIdentifications"
            }
          }
        }
      }
    }
  };

  return {
    POST
  };
};
