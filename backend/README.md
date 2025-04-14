# CRS Backend

This project builds the main application for the Credential Status (CRS) service.

## Deployment Process

This application leverages the [secure pipelines](https://github.com/govuk-one-login/devplatform-deploy/tree/main/sam-deploy-pipeline) from devplatform to deploy changes.

The configuration of those pipelines is located in [crs-infra](https://github.com/govuk-one-login/crs-infra)

To trigger the pipelines a pull request must be made against the `main` branch. Upon successful review the [push-to-main.yml](https://github.com/govuk-one-login/crs-backend/blob/main/.github/workflows/push-to-main.yml) workflow will run initiating deployments in `dev` and `build`. The `build` pipeline will continue through to `staging`, `integration` and `prod` upon successful deployments.

### Local dev-stack deployment

Configure your environment to assume a role in the `di-crs-dev` account.

Run the following commands:

```bash

stack_name="<your-stack-name-here>"

sam build --cached --parallel

sam deploy \
  --stack-name "${stack_name}" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM
```

## Architecture

The service consists of the following components:

- **AWS Lambda Function:** A Lambda function is triggered on a schedule (every minute) to perform the following tasks:
    - Retrieves a list of revoked credentials from a data source.
    - Updates a status list file in an S3 bucket with the revoked credential information.
- **Amazon S3 Bucket:** An S3 bucket stores the status list file, which contains the revocation status of credentials.
- **Amazon CloudFront Distribution:** A CloudFront distribution serves the status list file from the S3 bucket with appropriate caching configurations.
- **Amazon Route 53 Record Set:** A Route 53 record set maps a custom domain name to the CloudFront distribution, providing a publicly accessible endpoint for the credential status service.
- **TxMA SQS Queue:** A queue which CRS will write to allowing the analytics team to audit our service activity. Includes a KMS Encryption Key, Key Alias, SQS Queue, DLQ (for managing failed SQS messages), and a SQS Queue Policy.

## Configuration

The template includes several parameters that can be customized during deployment:

- **CodeSigningConfigArn:** The ARN of the AWS Code Signing Config to use for signing the Lambda function code.
- **Environment:** The target environment for deployment.
- **PermissionsBoundary:** The ARN of the permissions boundary to apply to any IAM role created by the template.
- **VpcStackName:** The stack name of the VPC where the Lambda function will be deployed.

## Security

The service incorporates security best practices, including:

- **Encryption:** The S3 bucket is encrypted using server-side encryption with Amazon S3-managed keys (SSE-S3).
- **Access Control:** The CloudFront distribution uses an origin access control to restrict access to the S3 bucket, ensuring that only authorised requests can retrieve the status list file.
- **Code Signing:** The Lambda function code is signed using AWS Code Signing to ensure its integrity and authenticity.
- **Permissions Boundary:** An optional permissions boundary can be applied to limit the permissions granted to the Lambda function and other resources.
- **TLS Minimum Version:** We are using TLSv1.2_2021 as the minimum protocol version

## Monitoring

The CloudFront distribution is configured to log access logs to an S3 bucket, allowing for monitoring and analysis of service usage.
