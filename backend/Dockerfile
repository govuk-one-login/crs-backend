FROM node:jod-alpine

WORKDIR /backend

# Create a new user 'test' to avoid running the app as a root
RUN adduser --disabled-password test && chown test .

COPY package.json package-lock.json ./
RUN npm install --ignore-scripts

## Update container, install awscli and check awscli is installed correctly
RUN apk upgrade && apk update; apk add --no-cache bash aws-cli && aws --version

# Copy the test files and the configuration files
COPY test/api/ ./test/api/
COPY babel.config.json jest.config.ts tsconfig.json ./

RUN mkdir ./results/
RUN chmod -R 007 ./results/

# Give user, 'test', permissions to execute test script and switch the user to 'test'
COPY run-tests.sh /
RUN chmod 005 /run-tests.sh


USER test

ENTRYPOINT ["/run-tests.sh"]
