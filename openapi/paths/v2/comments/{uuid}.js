const j2s = require( "hapi-joi-to-swagger" );
const CommentsController = require( "../../../../lib/controllers/v2/comments_controller" );
const commentsCreateSchema = require( "../../../schema/request/comments_create" );

module.exports = sendWrapper => {
  async function PUT( req, res ) {
    const results = await CommentsController.update( req );
    sendWrapper( req, res, null, results );
  }

  PUT.apiDoc = {
    tags: ["Comments"],
    summary: "Update a comment",
    security: [{
      jwtRequired: []
    }],
    requestBody: {
      content: {
        "multipart/form-data": {
          schema: j2s( commentsCreateSchema ).swagger
        },
        "application/json": {
          schema: j2s( commentsCreateSchema ).swagger
        }
      }
    },
    responses: {
      200: {
        description: "A list of comments",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ResultsComments"
            }
          }
        }
      }
    }
  };

  async function DELETE( req, res ) {
    await CommentsController.delete( req );
    sendWrapper( req, res, null, null );
  }

  DELETE.apiDoc = {
    tags: ["Comments"],
    summary: "Delete a comment",
    security: [{
      jwtRequired: []
    }],
    responses: {
      200: {
        description: "No response body; success implies deletion"
      }
    }
  };

  return {
    PUT,
    DELETE
  };
};
