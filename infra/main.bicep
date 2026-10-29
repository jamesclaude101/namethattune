// Name That Tune — all the Azure the game needs.
//
// Static Web App (Free) hosts the page and the managed Functions API.
// Cosmos DB serverless holds room state, with a per-item TTL so rooms
// clean themselves up six hours after they are created.
//
// The Static Web App is created with NO repository link on purpose: the
// GitHub Action in .github/workflows/deploy.yml owns deployment, so Azure
// never commits a workflow of its own into the repo.

@description('Name prefix for the resources.')
param namePrefix string = 'namethattune'

@description('Region for Cosmos DB.')
param location string = 'westus2'

@description('Static Web Apps Free tier is only offered in a few regions.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param staticWebAppLocation string = 'westus2'

@description('Free covers this game. Standard only matters if you want a private backend or SLA.')
@allowed([
  'Free'
  'Standard'
])
param sku string = 'Free'

var cosmosAccountName = toLower('${namePrefix}-cosmos-${uniqueString(resourceGroup().id)}')
var databaseName = 'namethattune'
var containerName = 'rooms'

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    minimalTlsVersion: 'Tls12'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource rooms 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      // -1 means "honour each item's own ttl"; rooms set six hours
      defaultTtl: -1
    }
  }
}

resource site 'Microsoft.Web/staticSites@2023-01-01' = {
  name: '${namePrefix}-swa'
  location: staticWebAppLocation
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

resource siteSettings 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: site
  name: 'appsettings'
  properties: {
    COSMOS_CONNECTION_STRING: cosmos.listConnectionStrings().connectionStrings[0].connectionString
    COSMOS_DATABASE: databaseName
    COSMOS_CONTAINER: containerName
  }
}

output staticWebAppName string = site.name
output defaultHostname string = site.properties.defaultHostname
output cosmosAccountName string = cosmos.name
output resourceGroupName string = resourceGroup().name
