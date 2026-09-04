setTimeout(function () { throw new Error("intentional fixture error"); }, 50);
console.log("fixture content script running");
