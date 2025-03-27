FROM node:iron-alpine

WORKDIR /backend-api

# Create a new user 'test' to avoid running the app as a root
RUN adduser --disabled-password test && chown test .

COPY package.json package-lock.json ./
RUN npm install --ignore-scripts

## Update container, install awscli and check awscli is installed correctly
# RUN apk upgrade && apk update; apk add --no-cache bash aws-cli && aws --version

# Copy the test files and the configuration files
# Currently no test files

COPY run-tests.sh ./
RUN chmod +x run-tests.sh

ENTRYPOINT ["./run-tests.sh"]