const callSyncMapName = 'CallCacheIvrMetrics';

const successHandler = (callback, props) => {
  const response = {
    ...props,
    status: 200
  };
  return callback(null, response);
};

const errorHandler = (error, message, response, callback) => {
  console.error(message);
  const responseBody = {
    success: false,
    message
  };
  response.setBody(JSON.stringify(responseBody));
  response.setStatusCode((error && error.status) || 500);
  return callback(null, response);
};

const getSyncMapClient = (context, syncMapName) => {
  const client = context.getTwilioClient();
  const syncClient = client.sync.services(context.TWILIO_SYNC_SERVICES_SID);
  const syncMapClient = syncClient.syncMaps(syncMapName);
  return syncMapClient;
};

const createSyncMap = async (context, syncMapName) => {
  const client = context.getTwilioClient();
  const syncClient = client.sync.services(context.TWILIO_SYNC_SERVICES_SID);
  console.log('Creating Sync Map', syncMapName);
  try {
    const syncMap = await syncClient.syncMaps.create({
      uniqueName: syncMapName,
      ttl: 86400
    });
    console.log('Sync Map created.');
    return syncMap;
  } catch (error) {
    console.error('Error creating Sync Map.');
    return undefined;
  }
};

const createSyncMapItem = async (syncMapClient, itemKey, itemValue) => {
  console.log('Creating Sync Map Item', itemKey);
  try {
    const syncMapItem = await syncMapClient.syncMapItems.create({
      key: itemKey,
      data: itemValue,
      itemTtl: 86400
    });
    console.log('Sync Map Item created.');
    return syncMapItem;
  } catch (error) {
    console.error('Error creating Sync Map Item.');
    return undefined;
  }
};

const updateSyncMapItem = async (syncMapClient, itemKey, itemValue) => {
  console.log('Updating sync map item', itemKey);
  try {
    const syncMapItem = await syncMapClient.syncMapItems(itemKey).update({
      data: itemValue
    });
    console.log('Sync Map Item updated.');
    return syncMapItem;
  } catch (error) {
    console.error('Error updating Sync Map Item.');
    return undefined;
  }
};

const updateCallSyncMap = async (context, callSid, taskSid) => {
  const syncMapClient = getSyncMapClient(context, callSyncMapName);
  const itemKey = callSid;
  const itemValue = { activeTask: taskSid };
  
  let item = await updateSyncMapItem(syncMapClient, itemKey, itemValue);
  if (item) {
    console.log('Call sync map updated');
    return;
  }

  item = await createSyncMapItem(syncMapClient, itemKey, itemValue);
  if (item) {
    console.log('Call sync map updated');
    return;
  }

  let syncMap = await createSyncMap(context, callSyncMapName);
  if (!syncMap) {
    const error = new Error('Error creating Sync Map. Unable to update call Sync Map.');
    throw error;
  }

  item = await createSyncMapItem(syncMapClient, itemKey, itemValue);
  if (item) {
    console.log('Call sync map updated');
  } else {
    const error = new Error('Error creating Sync Map Item. Unable to update call Sync Map.');
    throw error;
  }
};

const createIvrTask = async (context, callSid, firstIvrTaskSid, ivrPath) => {
  const client = context.getTwilioClient();
  const {
    TWILIO_WORKSPACE_SID,
    TWILIO_IVR_WORKFLOW_SID
  } = context;

  try {
    console.log('Creating IVR task');
    const attributes = {
      conversations: {
        conversation_attribute_1: callSid,
        conversation_id: firstIvrTaskSid,
        ivr_path: ivrPath
      }
    };
    const task = await client.taskrouter
      .workspaces(TWILIO_WORKSPACE_SID)
      .tasks
      .create({
        attributes: JSON.stringify(attributes),
        taskChannel: 'voice',
        workflowSid: TWILIO_IVR_WORKFLOW_SID
      });
    const taskSid = task && task.sid;
    console.log('Task created', taskSid);
    return taskSid;
  } catch (error) {
    console.error('Error creating task.', error);
    throw error;
  }
}

const cancelActiveTask = async (context, activeTaskSid, ivrPath) => {
  const client = context.getTwilioClient();
  const {
    TWILIO_WORKSPACE_SID,
  } = context;

  try {
    console.log('Canceling task', activeTaskSid);
    const task = await client.taskrouter
      .workspaces(TWILIO_WORKSPACE_SID)
      .tasks(activeTaskSid)
      .fetch();

    const taskDateCreated = task && task.dateCreated;
    const taskStartDate = new Date(taskDateCreated);
    const currentDate = new Date();
    const dateDiff = currentDate - taskStartDate;
    const ivrPathTimeSeconds = isNaN(dateDiff) ? 0 : Math.round(dateDiff / 1000);

    const attributes = task && task.attributes && JSON.parse(task.attributes);
    const newAttributes = {
      ...attributes,
      conversations: {
        ...attributes.conversations,
        abandoned: 'No',
        ivr_path: ivrPath,
        ivr_time: ivrPathTimeSeconds
      }
    }
    await client.taskrouter
      .workspaces(TWILIO_WORKSPACE_SID)
      .tasks(activeTaskSid)
      .update({
        attributes: JSON.stringify(newAttributes),
        assignmentStatus: 'canceled',
        reason: 'IVR path selected'
      });
  } catch (error) {
    console.error('Error canceling task.', error);
    throw error;
  }
}

exports.handler = async function(context, event, callback) {
  console.log('Event properties:');
  Object.keys(event).forEach(key => {
    console.log(`${key}: ${event[key]}`);
  });

  const {
    activeTaskSid,
    callSid,
    firstIvrTaskSid,
    isFinalIvrTask,
    ivrPath
  } = event;

  const response = new Twilio.Response();

  let taskSid;
  try {
    if (activeTaskSid) {
      await cancelActiveTask(context, activeTaskSid, ivrPath);
    }
  
    if (isFinalIvrTask === 'true') {
      await updateCallSyncMap(context, callSid);
    } else {
      taskSid = await createIvrTask(context, callSid, firstIvrTaskSid, ivrPath);
      await updateCallSyncMap(context, callSid, taskSid);
    }
  } catch (error) {
    const message = 'Error encountered. ' + error;
    return errorHandler(error, message, response, callback);
  }

  return successHandler(callback, { taskSid });
};
