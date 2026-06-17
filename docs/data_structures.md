# Data Structures
All structures use camelCase for properties and either epoch milliseconds or ISO8601 formats for dates and times, always in UTC.

## Activities
Activities are collections of data points and associated metadata. Since the metadata is expected to grow over time, and extensible schema is used:

```json
{
    "activityId": "act_2026-06-05T17:00:00Z",
    "status" : "initial",
    "metadata" : {
        // TBD ...
    },
    "points" : [
        { ... },
        { ... }
    ]
}
```
The *activityId* property is encoded with the prefix "act_" followed by the date and time in UTC that the user initiates a collection. Raw data points are periodically collected using a timestamp of *epoch milliseconds* as follows:
```json
{
    "ts" : 1780667775000,
    "lat" : 40.7128,
    "lon" : -73.9712,
    "alt" : 23.45,
    "spd" : 4.47,
    "acc" : 3.0
}
```
- `ts` = timestamp, in epoch milliseconds
- `lat` = latitude, in decimal degrees 
- `lon` = longitude, in decimal degrees
- `alt` = altitude, in meters above WGS84 ellipsoid (may be null)
- `spd` = speed, in meters per second (may be null)
- `acc` = accuracy of location, in meters (may be null) 

## Data Object Stores
The browser *IndexedDB* api is used to store activities and data and data points while collecting data.

### Data Collection Store (***active_points***)
When an activity is started, the *active_points* data store is cleared of all existing data and a new collection begins. Data is collected periodically and stored using the `ts` property as the primary key.

### Activities Store (***completed_activities***)
When an activity is completed, an activity instance is added to the *completed_activities* data store using the `activityId` property as the primary key. All of the data points from the *active_points* store are moved into the activity object. The status is then moved to the *pending* state.

#### Activity Status States
- `initial` = Activity was just created, no data points associated
- `pending` = Activity is done collecting data points, pending upload
- `complete` = Ativity is complete and uploaded to pernament storage.

## Data Synchronization
The brower's native **Background Sync API** is used to synchronize pending activities to back-end servers. The device may maintain local collections for a reasonable amount of time to support offline browsing and data comparisons. Metadata may be added to the activities, such as start/end time, activity type, equipment, conditions, overall distance, average speed, etc., and this listed is expected to grow over time.