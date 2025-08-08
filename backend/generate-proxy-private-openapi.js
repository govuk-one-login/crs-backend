// This script generates the OpenAPI spec used for the Proxy mock. 
// Through using the crs-private-spec.yaml as the starting point, it ensures the proxy is as similar as possible to the original API spec.

import { readFileSync, writeFileSync } from 'fs'
import { parse, stringify } from 'yaml'

// Read private apigw spec
const privateOpenApiSpec =  readFileSync('./openApiSpecs/crs-private-spec.yaml', 'utf8')
const parsedYaml = parse(privateOpenApiSpec)

// Update proxy integration to point to the proxy lambda
parsedYaml['paths']
['/issue']['post']['x-amazon-apigateway-integration']['uri']['Fn::Sub'] = "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${ProxyLambda}/invocations"

writeFileSync("./openApiSpecs/crs-proxy-private-spec.yaml",stringify(parsedYaml))