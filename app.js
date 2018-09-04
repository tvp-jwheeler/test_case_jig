const assert = require('assert');
const mysql = require('mysql');
const Q = require("q");
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jsonParser = bodyParser.json();
const jsonexport = require('jsonexport');
const fs = require('fs');
const download = require('download');
var os = require("os");
const app = express();
app.use(cors());

//----- Express Configuration
const app_port = 3000;
//----- MongoDB Connection
const MongoClient = require('mongodb').MongoClient;
const url = "mongodb://localhost:27017/";
const mongoDBName = "local";
//----- MySQL Connection
const sqlConnection = mysql.createConnection({
  host     : 'localhost',
  user     : 'root',
  password : '',
  database : 'test_case_knowledge'
});
sqlConnection.connect();
//ComponentForestTests collection queries
//Given the root name of a component, get its corresponding json document from mongo
function getRootComponent(name) {
	var deferred = Q.defer();
	MongoClient.connect(url, function(err, db) {
	  if (err) throw err;
	  var dbo = db.db(mongoDBName);
	  dbo.collection("component_forest_tests").find({"name": name}).toArray(function(err, results) {
	  	if(results.length > 0) {
	  		if(results.length > 1) {
	  			console.log("Component has duplicate roots, choosing first available.");
	  		}
	  		var component_root = results[0];
	  		db.close();
	  		deferred.resolve(component_root);
	  	} else {
	  		console.log("Component Root Does Not Exist.");
	  		deferred.reject(); //Question: What to put in the reject stmt? 
	  	}
	  });
	});
	return deferred.promise;
}
//Get Test Case Data From List Of Test Case Names
function retrieveTestCaseData(tcNameList){
	var deferred = Q.defer();
	//TODO: Validate the request payload before processing
	const testCaseNameStringList = tcNameList.map((tcNameOrObj) => {
		if(typeof tcNameOrObj === "string") {
			const tcName = tcNameOrObj;
			return '"'+tcName+'"' 
		} else if(typeof tcNameOrObj === "object") {
			const tcObj = tcNameOrObj;
			//There are test cases for a dependent component, extract its test cases
			if(tcObj.tests && tcObj.tests.length > 0) {
				const depTCNameList = tcObj.tests;
				return depTCNameList.map((tcName) => {
					return '"'+tcName+'"'; 
				});
			}
		}	
	}).join(",");
	//TODO: Handle Case where there are dependent components, will need to flatten the list and maintain relations for the report
	//Fromat prepared SQL query
	const qryTestCasesFromNameList = "SELECT * FROM testcases "+ 
									 "WHERE short_name IN ("+testCaseNameStringList+")";
	sqlConnection.query(qryTestCasesFromNameList, function (error, results, fields) {
		if (error) {
			deferred.reject(error);
		}
		deferred.resolve(results);
	});
	return deferred.promise;
}

function retrieveTestCaseDataForPage(pageName, componentsToTestCases) {
	var deferred = Q.defer();
	var tcNameListCollection = [];
	for (var component_name in componentsToTestCases) {
	    if (componentsToTestCases.hasOwnProperty(component_name)) {
	    	const tcNameList = componentsToTestCases[component_name];
	    	tcNameListCollection.push(tcNameList);
	    }
	}
	Promise.all(tcNameListCollection.map(retrieveTestCaseData)).then(tcDataParts => {
		//Update test Case Data to include page name and component name inside the object
		var tcdpNdx = 0;
		for (var component_name in componentsToTestCases) {
		    if (componentsToTestCases.hasOwnProperty(component_name)) {
		    	const tcNameOrObjList = componentsToTestCases[component_name];
		    	var tcDataPart = tcDataParts[tcdpNdx];
		    	var tcNdx = 0; //Maintain seperate test cases index to account for test cases with component dependencies
		    	for(var i=0; i<tcNameOrObjList.length; i++){
		    		var testCaseEntry = tcDataPart[tcNdx];
		    		const tcNameOrObj = tcNameOrObjList[i];
		    		if(typeof tcNameOrObj === "object") {
		    			//Test Case has dependent component, process the dependent component test cases
		    			const tcObj = tcNameOrObj;
		    			const depTCName = tcObj.name;
		    			if(tcObj.tests && tcObj.tests.length > 0) {
		    				const depTCTests = tcObj.tests;
		    				for(var j=0; j<depTCTests.length; j++) {
		    					testCaseEntry = tcDataPart[tcNdx];
		    					testCaseEntry["pageName"] = pageName;
		    					testCaseEntry["components"] = component_name + "," + depTCName;
		    					tcNdx++;
		    				}
		    			}
		    		} else if(typeof tcNameOrObj == "string") {
		    			testCaseEntry["pageName"] = pageName;
		    			testCaseEntry["components"] = component_name;
		    			const tcName = tcNameOrObj; 
		    		}
		    		tcNdx++;
		    	}
		    	tcdpNdx++; 	
		    }
		}
		const flattenedTCData = [].concat.apply([], tcDataParts);
		try {
			deferred.resolve(flattenedTCData);
		} catch(err) {
			deferred.reject(err);
		}
	});
	return deferred.promise;
}

//Generate CSV File From Test Case Data
function generateCSVFromTestCaseData(tcData) {
	var deferred = Q.defer();
	jsonexport(tcData,function(err, csv){
	    if(err) {
	    	deferred.reject(err);
	    } 
	    deferred.resolve(csv);
	});
	return deferred.promise;
}
//Given a string of csv data, create a csv file
//TODO: Store these files in an S3 Bucket? 
function createCSVFile(csvData, objectName, objectType) {
	var deferred = Q.defer();
	const filePath = "./tmp_test_plans/"+objectName+"_"+objectType+"TestPlan_"+Date.now()+".csv";
	fs.writeFile(filePath, csvData, function(err) {
	    if(err) {
	        return deferred.reject(err);
	    }
	    deferred.resolve(filePath);
	}); 
	return deferred.promise;
}
//Get All Module Documents
//TODO: Create Mongo Wrapper For Queries
function getAllModules() {
	var deferred = Q.defer();
	MongoClient.connect(url, function(err, db) {
	  if (err) throw err;
	  var dbo = db.db(mongoDBName);
	  dbo.collection("modules").find({}).toArray(function(err, results) {
	  		if(err || !results) {
	  			deferred.reject(err);
	  		}
	  		deferred.resolve(results);
	  });
	});
	return deferred.promise;
}
function getModule(moduleName) {
	var deferred = Q.defer();
	MongoClient.connect(url, function(err, db) {
	  if (err) throw err;
	  var dbo = db.db(mongoDBName);
	  dbo.collection("modules").findOne({"module": moduleName}, function(err, result) {
	  		if(err || !result) {
	  			deferred.reject(err);
	  		}
	  		deferred.resolve(result);
	  	});
	});
	return deferred.promise;
}
function getPage(pageName) {
	var deferred = Q.defer();
	MongoClient.connect(url, function(err, db) {
	  if (err) throw err;
	  var dbo = db.db(mongoDBName);
	  dbo.collection("pages_components").findOne({"pageName": pageName},function(err, result) {
	  		if(err || !result) {
	  			deferred.reject(err);
	  		}
	  		deferred.resolve(result);
	  	});
	});
	return deferred.promise;
}
//Get all the pages objects for a given module name
function getPagesForModule(moduleName) {
	return getModule(moduleName).then(function(moduleObj) {
		var pageNames = moduleObj.pages;
		return Promise.all(pageNames.map(getPage)).then(pageObjects => {
			return pageObjects;
		}); 
	});
}


function getTestCaseMapForPage(page_name) {
	var deferred = Q.defer();
	const component_names_promise = getComponentsForPage(page_name)
	.then(function(component_names) {
		return component_names;
	})
	const test_case_lists_promise = component_names_promise.then((component_names)=>{
		return Promise.all(component_names.map(gatherTestCases));
	});
	Promise.all([component_names_promise,test_case_lists_promise]).then(function([component_names, test_case_lists]) {
		//Component names and Test Case Lists have a 1-1 mapping by index i
		var componentNameToTestCaseListMap = {};
		for(var i=0; i<component_names.length; i++) {
			const component_name = component_names[i];
			const test_case_list = test_case_lists[i];
			componentNameToTestCaseListMap[component_name] = test_case_list;
		}
		const pageComponentTests = {
			"pageName": page_name,
			"componentsToTestCases": componentNameToTestCaseListMap
		}
		try{
			deferred.resolve(pageComponentTests);
		} catch(err) {
			deferred.reject(err);
		}
	});
	return deferred.promise;
}

function getComponentsForPage(page_name) {
	return getPage(page_name).then(function(pageObj){
		return pageObj.components;
	});
}
//--- Logic For Test Case Collection Algo On Component Forest -- //
//Check if the name of child in a component tree node's list of children exists. Return the object if there is match, otherwise, return an empty object.
function getMatchingChild(name, component_obj) {
	var child_obj = {};
	var children = component_obj.children; 
	if(!children || children.length == 0) {
		return child_obj;
	}
	for(var i=0; i<children.length; i++) {
		var child = children[i];
		if(child.name === name) {
			child_obj = child;
		}
	}
	return child_obj;
}
function gatherTestCases(component_name) {
	var component_tree_parts = component_name.split("_"); //Step 1, split the component name into its tree path
	var curNdx = component_tree_parts.length-1;
	var component_root = component_tree_parts[curNdx];
	return getRootComponent(component_root).then(function(root_component_obj){
		return traverseAndCollectTests(component_tree_parts, root_component_obj, []); //Steps 2, 3 - instantiate empty test cases array and start traversing right to left
	}); 
}
function traverseAndCollectTests(component_tree_parts, component_obj, test_case_list) {
	if(component_obj.tests && component_obj.tests.length > 0) {
		test_case_list = test_case_list.concat(component_obj.tests); //Step 4, add test cases to list in current node of component tree
	}
	//Grab all test cases where there are dependent components
	if(component_obj.depComponents && component_obj.depComponents.length > 0) {
		for(var i=0; i<component_obj.depComponents.length; i++) {
			var dep_component_obj = component_obj.depComponents[i];
			//TODO: Build a function to check if a component exists by searching the tree to see if there is a valid nesting before grabbing tests. currently assuming dep component has valid name for MVP
			//Step 7 - Determine if the component has dependent objects, if it does, append all tests for the dependent components. If it does not, continue
			test_case_list.push(dep_component_obj);
		}
	} 
	component_tree_parts = component_tree_parts.slice(0, component_tree_parts.length-1);  //Step 5, test cases were added, look at the next level down the tree and repeat process
	var curNdx = component_tree_parts.length-1;
	if(!component_tree_parts || component_tree_parts.length == 0) {
		return test_case_list; //Step 6, Base Case, finished traversing the tree return the test cases found
	}
	if(component_obj.children && component_obj.children.length > 0) {
		//Step 8 - Determine if the component contains the child component, if it does, recurse the child component object. If it does not, continue
		var child_component_obj = getMatchingChild(component_tree_parts[curNdx], component_obj);
		if(Object.keys(child_component_obj).length > 0) {
			return traverseAndCollectTests(component_tree_parts, child_component_obj, test_case_list); //Recurse starting again with step 4
		}
	}
} 
//--- REST Endpoints
app.get("/getAllModules", function(req,res) {
	getAllModules().then(function(modules) {
		res.send(modules);
	});
});
app.get("/getPagesForModule/:module_name", function(req,res) {
	getPagesForModule(req.params.module_name).then(function(page_objects) {
		res.send(page_objects);
	});
});
//TODO: Create a getAllPages Endpoint


app.get("/getComponentsForPage/:page_name", function(req,res) {
	getComponentsForPage(req.params.page_name).then(function(componentNames){
		res.send(componentNames);
	});
});
app.get("/getTestCaseMapForPage/:page_name", function(req,res){
	const page_name = req.params.page_name;
	getTestCaseMapForPage(page_name).then((pageComponentTests) => {
		res.send(pageComponentTests);
	});
});
app.get("/getTestCaseNamesForComponent/:component_name", function(req, res) {
	gatherTestCases(req.params.component_name).then(function(test_case_list) {
		res.send(test_case_list);
	});
});
//Post body is the output from the getTestCaseMapForPage endpoint
app.post("/retrieveTestCasesFromTestCaseMapForPage/", jsonParser, function(req,res) {
	const componentsToTestCases = req.body.componentsToTestCases;
	const pageName = req.body.pageName;
	retrieveTestCaseDataForPage(pageName, componentsToTestCases).then(function(pageTCData) {
		res.send(pageTCData);
	});
});
//Post body is an array of test case short names [tc1, tc2, ... , tcN]
app.post("/retrieveTestCasesFromNameList", jsonParser, function(req, res) {
	//TODO: maybe use middleware for this req body as it is a common req?
	const tcNameList = req.body; //TODO: Flatten this for when there are dep component objs. Will need pre-processing for this case
	retrieveTestCaseData(tcNameList).then(function(tcData) {
		res.send(tcData);
	});
});
//TODO: Apply DRY principle to generateCSV logic
//Post body is a module_name in JSON obj
app.post("/generateCSVForModule", jsonParser, function(req, res){
	const moduleName = req.body.module_name
	getModule(moduleName).then(function(moduleObj) {
		var page_name_list = moduleObj.pages;
		Promise.all(page_name_list.map(getTestCaseMapForPage))
		.then(testCaseMapForPageList => {
			return Promise.all(testCaseMapForPageList.map((testCaseMapForPage) => {
				const pageName = testCaseMapForPage.pageName;
				const componentsToTestCases = testCaseMapForPage.componentsToTestCases;
				return retrieveTestCaseDataForPage(pageName, componentsToTestCases);
			}));
		}).then(function(testCaseDataForPageList){
			const flattenedTCData = [].concat.apply([], testCaseDataForPageList)
			return flattenedTCData;
		}).then(pageTestCaseData => {
			return generateCSVFromTestCaseData(pageTestCaseData);
		})
		.then(function(pageTestCaseCSVData) {
			return createCSVFile(pageTestCaseCSVData, moduleName, "module");
		})
		.then(function(filePath){
			res.send(filePath);	
		});
	});
});
//Post body is the output from the getTestCaseMapForPage endpoint
app.post("/generateCSVFromTestCaseMapForPage", jsonParser, function(req, res){
	const componentsToTestCases = req.body.componentsToTestCases;
	const pageName = req.body.pageName;
	retrieveTestCaseDataForPage(pageName, componentsToTestCases)
	.then(function(pageTestCaseData) {
		return generateCSVFromTestCaseData(pageTestCaseData);
	})
	.then(function(pageTestCaseCSVData) {
		return createCSVFile(pageTestCaseCSVData, pageName, "page");
	})
	.then(function(filePath){
		res.send(filePath);	
	});
});
//Post body is an array for test case short name, 
//an objectName (name of module, page or component) and type of object (is it a module, page or component)
app.post("/generateCSVFromTestCaseNameList", jsonParser, function(req, res){
	//TODO: maybe use middleware for this req body as it is a common req?
	const tcNameList = req.body.tests; //TODO: Flatten this for when there are dep component objs. Will need pre-processing for this case
	const componentName = req.body.componentName;
	retrieveTestCaseData(tcNameList)
	.then(function(tcData) { //TODO: Repeated code, middleware may rectify this
		return generateCSVFromTestCaseData(tcData);
	})
	.then(function(tcCSVData) {
		return createCSVFile(tcCSVData, componentName, "component");
	})
	.then(function(filePath){
		res.send(filePath);	
	});
});
app.get("/downloadFile/:filePath", function(req,res) {
	const filePath = decodeURIComponent(req.params.filePath);
	console.log("The File Path To Download");
	console.log(filePath);	
	res.download(filePath);
});
// app.get("/getTestCaseCountsForAllModules/:module_name", function(req,res){
// });
// app.get("/getTestCaseCountsForPages/:module_name", function(req,res){
// });
// app.get("/getTestCaseCountsForComponents/:page_name", function(req,res){
// });
app.listen(3000);